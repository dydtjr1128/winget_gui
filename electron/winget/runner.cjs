// Process orchestration for winget: trusted path resolution, a serialized
// runner, truncated-id resolution, and the list/upgrade flows. This is the only
// winget module that touches child_process / the filesystem.

const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createTerminalLogProcessor,
  parseWingetUpgradeResult,
  parseWingetExportPackages,
  decodeWingetExportBuffer,
  summarizeWingetFailure,
  classifyWingetFailure,
  hasTruncatedMarker,
  getTruncatedPrefix
} = require('./parser.cjs');
const {
  resolvePackageIdFromListOutput,
  resolvePackageIdFromSearchOutput,
  resolvePackageIdFromExport
} = require('./resolver.cjs');
const {
  buildListArgs,
  buildListByIdArgs,
  buildSearchArgs,
  buildExportArgs,
  buildUpgradeArgs
} = require('./args.cjs');

// Looks for the real winget binary inside the protected, admin-only-writable
// %ProgramFiles%\WindowsApps install. This is the most trustworthy location: a
// standard user cannot replace it before elevation. Returns '' when it cannot be
// read (e.g. when the app is not elevated) so the caller can fall back.
function findInstalledWingetExe() {
  const programFiles = process.env.ProgramW6432 || process.env.ProgramFiles;
  if (!programFiles) {
    return '';
  }

  const windowsApps = path.join(programFiles, 'WindowsApps');
  let entries;
  try {
    entries = fs.readdirSync(windowsApps);
  } catch {
    return '';
  }

  const installDirs = entries
    .filter((name) => /^Microsoft\.DesktopAppInstaller_.+__8wekyb3d8bbwe$/.test(name))
    .sort()
    .reverse();

  for (const dir of installDirs) {
    const exe = path.join(windowsApps, dir, 'winget.exe');
    try {
      if (fs.existsSync(exe)) {
        return exe;
      }
    } catch {
      // Try the next install directory.
    }
  }

  return '';
}

// Resolves winget to the most trusted available path. Because the app runs
// elevated, a bare `winget` spawn could pick up a malicious winget.exe planted
// earlier in PATH or in the working directory and run it as administrator.
// Prefer the admin-only WindowsApps install, then the per-user execution alias,
// and only fall back to a bare PATH lookup if neither is found.
let cachedWingetCommand;
function resolveWingetCommand() {
  if (cachedWingetCommand !== undefined) {
    return cachedWingetCommand;
  }

  const installed = findInstalledWingetExe();
  if (installed) {
    cachedWingetCommand = installed;
    return cachedWingetCommand;
  }

  const localAppData = process.env.LOCALAPPDATA;
  const aliasPath = localAppData
    ? path.join(localAppData, 'Microsoft', 'WindowsApps', 'winget.exe')
    : '';

  cachedWingetCommand = aliasPath && fs.existsSync(aliasPath) ? aliasPath : 'winget';
  return cachedWingetCommand;
}

// A directory only administrators can write to, used as the spawn working
// directory so a planted ".\\winget.exe" in an attacker-controlled folder can
// never sit ahead of the resolved winget on the CreateProcess search path.
function safeSpawnCwd() {
  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return path.join(systemRoot, 'System32');
}

function createWingetRunner({ spawn: spawnImpl = spawn } = {}) {
  const events = new EventEmitter();
  let currentProcess = null;
  let cancelled = false;
  let wingetChain = Promise.resolve();

  function runWinget(args, options = {}) {
    const launch = () => new Promise((resolve) => {
      // A cancel can land while this call is still queued behind another winget
      // process; do not start a new child once cancellation has been requested.
      if (cancelled) {
        resolve({ ok: false, code: null, stdout: '', stderr: '' });
        return;
      }

      const emitOutput = options.emitOutput !== false;
      const child = spawnImpl(resolveWingetCommand(), args, {
        windowsHide: true,
        shell: false,
        cwd: safeSpawnCwd()
      });

      currentProcess = child;
      let stdout = '';
      let stderr = '';
      const logProcessor = emitOutput
        ? createTerminalLogProcessor((entry) => events.emit('log', entry))
        : null;

      child.stdout.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        stdout += text;
        logProcessor?.write(text);
      });

      child.stderr.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        stderr += text;
        logProcessor?.write(text);
      });

      child.on('error', (error) => {
        currentProcess = null;
        logProcessor?.flush();
        if (emitOutput) {
          events.emit('log', error.message);
        }
        resolve({
          ok: false,
          code: -1,
          errorCode: error.code,
          stdout,
          stderr: `${stderr}${error.message}`
        });
      });

      child.on('close', (code) => {
        currentProcess = null;
        logProcessor?.flush();
        resolve({
          ok: code === 0,
          code,
          stdout,
          stderr
        });
      });
    });

    // Serialize winget invocations: a second concurrent call would otherwise
    // overwrite the single currentProcess slot that cancel() depends on, so a
    // cancel could kill the wrong child or none at all.
    const result = wingetChain.then(launch, launch);
    wingetChain = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  // Loads installed packages via `winget export`, which emits full, untruncated
  // PackageIdentifiers as JSON. This is the most reliable way to resolve a
  // truncated upgrade-list id; the table-based list/search fallbacks reprint the
  // id through the same narrow console and can truncate it again. Returns an
  // empty list on any failure so callers fall back to the table queries.
  async function loadInstalledPackagesViaExport() {
    // A private random temp directory keeps the elevated export output off a
    // predictable, same-user-writable path and avoids collisions between
    // concurrent calls.
    const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'winget-gui-export-'));
    const exportPath = path.join(exportDir, 'packages.json');

    try {
      // `winget export` writes JSON to the output file (not stdout) and may exit
      // non-zero when some installed packages are absent from a source, so read
      // the file regardless of the exit code.
      await runWinget(buildExportArgs(exportPath), { emitOutput: false });
      return parseWingetExportPackages(decodeWingetExportBuffer(fs.readFileSync(exportPath)));
    } catch {
      return [];
    } finally {
      try {
        fs.rmSync(exportDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup of the temp export directory.
      }
    }
  }

  async function resolveTruncatedPackageIds(packages) {
    const resolvedPackages = [];
    const hasTruncated = packages.some((item) => hasTruncatedMarker(item.id));
    const exportPackages = hasTruncated ? await loadInstalledPackagesViaExport() : [];

    for (const item of packages) {
      if (!hasTruncatedMarker(item.id)) {
        resolvedPackages.push({
          ...item,
          idResolutionStatus: 'complete'
        });
        continue;
      }

      const prefix = getTruncatedPrefix(item.id);
      events.emit('log', `잘린 패키지 ID 확인 중: ${item.id}`);

      // 1) winget export: full ids as JSON, disambiguated by installed version.
      let resolvedId = resolvePackageIdFromExport(
        exportPackages,
        prefix,
        item.source,
        item.installedVersion
      );

      // 2) Fall back to the installed-package list (table output): it only
      // contains what is actually installed and carries versions to
      // disambiguate same-prefix variants (e.g. VCRedist x64/x86).
      if (!resolvedId) {
        const listResult = await runWinget(buildListByIdArgs(prefix, item.source), {
          emitOutput: false
        });
        resolvedId = listResult.ok
          ? resolvePackageIdFromListOutput(
              listResult.stdout,
              prefix,
              item.source,
              item.installedVersion,
              item.availableVersion
            )
          : null;
      }

      // 3) Fall back to a catalog search (matches by name) as a last resort.
      if (!resolvedId) {
        const searchResult = await runWinget(buildSearchArgs(prefix, item.source), {
          emitOutput: false
        });
        resolvedId = searchResult.ok
          ? resolvePackageIdFromSearchOutput(searchResult.stdout, prefix, item.source, item.name)
          : null;
      }

      if (resolvedId) {
        events.emit('log', `패키지 ID 보강: ${item.id} → ${resolvedId}`);
        resolvedPackages.push({
          ...item,
          id: resolvedId,
          resolvedFromId: item.id,
          idResolutionStatus: 'resolved'
        });
        continue;
      }

      events.emit('log', `패키지 ID 보강 실패: ${item.id}`);
      resolvedPackages.push({
        ...item,
        idResolutionStatus: 'unresolved'
      });
    }

    return resolvedPackages;
  }

  async function listUpgrades(options = {}) {
    cancelled = false;
    events.emit('log', 'winget upgrade 목록을 불러오는 중...');
    const result = await runWinget(buildListArgs(options));
    const parsed = parseWingetUpgradeResult(result.stdout);
    const packages = await resolveTruncatedPackageIds(parsed.packages);
    return {
      ...result,
      ...parsed,
      packages,
      parsedCount: packages.length,
      wingetMissing: result.errorCode === 'ENOENT'
    };
  }

  async function upgradeSelected(packages, options = {}) {
    cancelled = false;
    const results = [];

    for (const item of packages) {
      if (cancelled) {
        results.push({
          id: item.id,
          name: item.name,
          ok: false,
          code: null,
          skipped: true
        });
        continue;
      }

      events.emit('package-start', item);
      events.emit('log', `업데이트 시작: ${item.name || item.id}`);
      if (hasTruncatedMarker(item.id)) {
        const itemResult = {
          id: item.id,
          name: item.name,
          ok: false,
          code: null,
          failureKind: 'id-resolution',
          failureDetail: `winget 목록에서 패키지 ID가 잘려 안전하게 업데이트할 수 없습니다: ${item.id}`,
          stdout: '',
          stderr: ''
        };
        results.push(itemResult);
        events.emit('package-complete', itemResult);
        continue;
      }

      const args = buildUpgradeArgs(item.id, options);
      const result = await runWinget(args);
      const failureDetail = summarizeWingetFailure(result);
      const itemResult = {
        id: item.id,
        name: item.name,
        ok: result.ok,
        code: result.code,
        failureKind: classifyWingetFailure(result),
        failureDetail,
        stdout: result.stdout,
        stderr: result.stderr
      };
      results.push(itemResult);
      events.emit('package-complete', itemResult);
    }

    events.emit('queue-complete', results);
    return results;
  }

  function cancel() {
    cancelled = true;
    if (currentProcess) {
      currentProcess.kill();
    }
  }

  return {
    events,
    listUpgrades,
    upgradeSelected,
    cancel
  };
}

module.exports = {
  createWingetRunner
};
