const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function quotePowerShellSingle(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

function getRelaunchArgs({ isPackaged, appPath, argv }) {
  const currentArgv = Array.isArray(argv) ? argv : [];

  if (isPackaged) {
    return currentArgv.slice(1);
  }

  return [appPath, ...currentArgv.slice(2)].filter(Boolean);
}

function getElevatedRelaunchOptions({
  isPackaged,
  appPath,
  argv,
  execPath,
  cwd,
  env = process.env
}) {
  const portableFile = typeof env.PORTABLE_EXECUTABLE_FILE === 'string'
    ? env.PORTABLE_EXECUTABLE_FILE
    : '';
  const portableDir = typeof env.PORTABLE_EXECUTABLE_DIR === 'string'
    ? env.PORTABLE_EXECUTABLE_DIR
    : '';
  const filePath = portableFile || execPath;

  return {
    filePath,
    args: getRelaunchArgs({ isPackaged, appPath, argv }),
    cwd: portableFile ? portableDir || path.dirname(portableFile) : cwd
  };
}

function buildStartProcessCommand({ filePath, args = [], cwd = '', elevated = true }) {
  const argumentList =
    args.length > 0
      ? ` -ArgumentList @(${args.map(quotePowerShellSingle).join(', ')})`
      : '';
  const workingDirectory = cwd ? ` -WorkingDirectory ${quotePowerShellSingle(cwd)}` : '';
  const verb = elevated ? ' -Verb RunAs' : '';
  return `Start-Process -FilePath ${quotePowerShellSingle(filePath)}${argumentList}${workingDirectory}${verb}`;
}

// Builds the PowerShell SCRIPT (run as a detached helper) that first waits for
// the original instance to fully exit, then relaunches the app elevated. The
// portable launcher unpacks the app into a single shared directory and will not
// start a second instance against it, so the elevated relaunch must not begin
// until the original process (and its child windows) are gone. If the user
// declines the UAC prompt the app is relaunched without elevation so they are
// not left with no window at all. The script removes itself when finished.
function buildDeferredRestartScript({
  filePath,
  args = [],
  cwd = '',
  waitForName = '',
  waitForDir = '',
  timeoutMs = 15000
}) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('An executable path is required.');
  }

  const elevatedStart = buildStartProcessCommand({ filePath, args, cwd, elevated: true });
  const fallbackStart = buildStartProcessCommand({ filePath, args, cwd, elevated: false });
  const timeoutSeconds = Math.max(1, Math.round(timeoutMs / 1000));

  const waitBlock =
    waitForName && waitForDir
      ? [
          `$deadline = (Get-Date).AddSeconds(${timeoutSeconds})`,
          'while ((Get-Date) -lt $deadline) {',
          `  $running = Get-CimInstance Win32_Process -Filter ${quotePowerShellSingle(
            `Name='${waitForName}'`
          )} -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -like ${quotePowerShellSingle(
            `${waitForDir}\\*`
          )} }`,
          '  if (-not $running) { break }',
          '  Start-Sleep -Milliseconds 250',
          '}'
        ].join('\n')
      : '';

  return [
    waitBlock,
    // Give the portable launcher stub a moment to release the extraction
    // directory after the windows close, before relaunching into it.
    'Start-Sleep -Milliseconds 700',
    `try { ${elevatedStart} } catch { ${fallbackStart} }`,
    'Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue'
  ]
    .filter(Boolean)
    .join('\n');
}

function isRunningElevated({ platform = process.platform, spawnSyncImpl = spawnSync } = {}) {
  if (platform !== 'win32') {
    return false;
  }

  const result = spawnSyncImpl('net', ['session'], {
    windowsHide: true,
    stdio: 'ignore'
  });

  return result.status === 0;
}

// Writes the deferred-restart helper to a temporary script and launches it as a
// fully independent process via Start-Process, so it survives this process
// quitting. (A child started with child_process.spawn — even detached — does
// not reliably outlive an Electron app.quit(); a Start-Process launch does.)
// Returns immediately; the caller should quit so the elevated copy can take
// over once this instance is gone.
function startDeferredElevatedRestart({
  filePath,
  args = [],
  cwd = '',
  waitForName = '',
  waitForDir = '',
  timeoutMs = 15000,
  platform = process.platform,
  tmpDir = os.tmpdir(),
  pid = process.pid,
  writeFileImpl = fs.writeFileSync,
  spawnSyncImpl = spawnSync
}) {
  if (platform !== 'win32') {
    return {
      ok: false,
      message: 'Administrator elevation is only available on Windows.'
    };
  }

  if (!filePath || typeof filePath !== 'string') {
    return { ok: false, message: 'An executable path is required.' };
  }

  try {
    const scriptPath = path.join(tmpDir, `winget-gui-elevate-${pid}.ps1`);
    const script = buildDeferredRestartScript({
      filePath,
      args,
      cwd,
      waitForName,
      waitForDir,
      timeoutMs
    });
    writeFileImpl(scriptPath, script, 'utf8');

    const launchCommand =
      `Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList ` +
      `@('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ${quotePowerShellSingle(scriptPath)})`;

    const result = spawnSyncImpl(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', launchCommand],
      { windowsHide: true }
    );

    if (result && result.error) {
      return { ok: false, message: result.error.message };
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

module.exports = {
  buildDeferredRestartScript,
  buildStartProcessCommand,
  getElevatedRelaunchOptions,
  getRelaunchArgs,
  isRunningElevated,
  startDeferredElevatedRestart
};
