const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const TRUNCATION_PATTERN = /…|\.\.\./;

function stripTerminalControlSequences(text) {
  return String(text ?? '')
    .replace(ANSI_PATTERN, '')
    .replace(/\x08/g, '')
    .replace(/\u001b/g, '');
}

function sanitizeWingetOutput(text) {
  return stripTerminalControlSequences(text)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/^\n+/, '')
    .trimEnd();
}

function createTerminalLogProcessor(emit) {
  let line = '';
  let hasReplaceTarget = false;

  function emitBufferedLine(replace) {
    const text = line.trim();
    line = '';

    if (!text) {
      return false;
    }

    emit({
      text,
      replace: Boolean(replace)
    });
    return true;
  }

  function write(chunk) {
    const text = stripTerminalControlSequences(chunk).replace(/\r\n/g, '\n');

    for (const char of text) {
      if (char === '\r') {
        const emitted = emitBufferedLine(hasReplaceTarget);
        hasReplaceTarget = emitted || hasReplaceTarget;
        continue;
      }

      if (char === '\n') {
        emitBufferedLine(hasReplaceTarget);
        hasReplaceTarget = false;
        continue;
      }

      line += char;
    }
  }

  function flush() {
    emitBufferedLine(hasReplaceTarget);
    hasReplaceTarget = false;
  }

  return {
    write,
    flush
  };
}

function isCombiningCodePoint(codePoint) {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  );
}

function isWideCodePoint(codePoint) {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6)
  );
}

function getDisplayWidth(text) {
  let width = 0;

  for (const char of String(text ?? '')) {
    const codePoint = char.codePointAt(0);
    if (!codePoint || isCombiningCodePoint(codePoint)) {
      continue;
    }

    width += isWideCodePoint(codePoint) ? 2 : 1;
  }

  return width;
}

function getStringIndexAtDisplayColumn(line, targetColumn) {
  let displayColumn = 0;
  let stringIndex = 0;

  for (const char of String(line ?? '')) {
    if (displayColumn >= targetColumn) {
      return stringIndex;
    }

    displayColumn += getDisplayWidth(char);
    stringIndex += char.length;
  }

  return String(line ?? '').length;
}

function findHeaderLabelStart(headerLine, labels) {
  const candidates = Array.isArray(labels) ? labels : [labels];
  const starts = candidates
    .map((label) => {
      const index = headerLine.indexOf(label);
      return index >= 0 ? getDisplayWidth(headerLine.slice(0, index)) : -1;
    })
    .filter((start) => start >= 0);

  return starts.length > 0 ? Math.min(...starts) : -1;
}

function getHeaderStarts(headerLine) {
  const headerSets = [
    [
      ['name', 'Name'],
      ['id', ['Id', 'ID']],
      ['installedVersion', 'Version'],
      ['availableVersion', 'Available'],
      ['source', 'Source']
    ],
    [
      ['name', '이름'],
      ['id', ['장치 ID', 'ID']],
      ['installedVersion', '버전'],
      ['availableVersion', '사용 가능'],
      ['source', '원본']
    ]
  ];

  for (const headers of headerSets) {
    const columns = headers
      .map(([key, labels]) => ({ key, start: findHeaderLabelStart(headerLine, labels) }))
      .filter((column) => column.start >= 0)
      .sort((a, b) => a.start - b.start);

    const keys = new Set(columns.map((column) => column.key));
    if (
      keys.has('name') &&
      keys.has('id') &&
      keys.has('installedVersion') &&
      keys.has('availableVersion')
    ) {
      return columns;
    }
  }

  return [];
}

function getFixedValue(line, column, nextColumn) {
  if (getDisplayWidth(line) <= column.start) {
    return '';
  }

  const start = getStringIndexAtDisplayColumn(line, column.start);
  const end = nextColumn ? getStringIndexAtDisplayColumn(line, nextColumn.start) : line.length;
  return line.slice(start, end).trim();
}

function isPackageId(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._+-]{2,}$/.test(value);
}

function isKnownSource(value) {
  return /^(winget|msstore)$/i.test(value);
}

function parseDataLine(line, options = {}) {
  const allowMissingSource = options.allowMissingSource !== false;
  const tokens = line.trim().split(/\s+/);

  if (tokens.length >= 5 && isKnownSource(tokens[tokens.length - 1])) {
    const source = tokens[tokens.length - 1];
    const availableVersion = tokens[tokens.length - 2];
    const installedVersion = tokens[tokens.length - 3];
    const id = tokens[tokens.length - 4];
    const name = tokens.slice(0, -4).join(' ');

    if (name && isPackageId(id)) {
      return {
        name,
        id,
        installedVersion,
        availableVersion,
        source
      };
    }
  }

  if (allowMissingSource && tokens.length >= 4) {
    const availableVersion = tokens[tokens.length - 1];
    const installedVersion = tokens[tokens.length - 2];
    const id = tokens[tokens.length - 3];
    const name = tokens.slice(0, -3).join(' ');

    if (name && isPackageId(id)) {
      return {
        name,
        id,
        installedVersion,
        availableVersion,
        source: ''
      };
    }
  }

  return null;
}

function parseSearchDataLine(line) {
  const tokens = line.trim().split(/\s+/);

  if (tokens.length < 4 || !isKnownSource(tokens[tokens.length - 1])) {
    return null;
  }

  const source = tokens[tokens.length - 1];
  const version = tokens[tokens.length - 2];
  const id = tokens[tokens.length - 3];
  const name = tokens.slice(0, -3).join(' ');

  if (!name || !isPackageId(id)) {
    return null;
  }

  return {
    name,
    id,
    version,
    source
  };
}

function hasTruncatedMarker(value) {
  return TRUNCATION_PATTERN.test(String(value ?? ''));
}

function getTruncatedPrefix(value) {
  return String(value ?? '').split(TRUNCATION_PATTERN)[0].trim();
}

function normalizeSearchName(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function getSearchNameMatchPrefixes(value) {
  const prefix = getTruncatedPrefix(value);
  const withoutTrailingVersion = prefix.replace(
    /\s+v?\d+(?:[._-]\d+)+(?:[-+][\p{L}\p{N}._-]+)?\s*$/iu,
    ''
  );
  const candidates = [prefix, withoutTrailingVersion]
    .map((candidate) => normalizeSearchName(candidate))
    .filter(Boolean);

  return [...new Set(candidates)];
}

function getSearchHeaderStarts(headerLine) {
  const headerSets = [
    [
      ['name', 'Name'],
      ['id', ['Id', 'ID']],
      ['version', 'Version'],
      ['source', 'Source']
    ],
    [
      ['name', '이름'],
      ['id', ['장치 ID', 'ID']],
      ['version', '버전'],
      ['source', '원본']
    ]
  ];

  for (const headers of headerSets) {
    const columns = headers
      .map(([key, labels]) => ({ key, start: findHeaderLabelStart(headerLine, labels) }))
      .filter((column) => column.start >= 0)
      .sort((a, b) => a.start - b.start);

    const keys = new Set(columns.map((column) => column.key));
    if (keys.has('name') && keys.has('id') && keys.has('version')) {
      return columns;
    }
  }

  return [];
}

function parseWingetSearchRows(output) {
  const lines = sanitizeWingetOutput(output)
    .split(/\r?\n/)
    .map((line) => line.trimEnd());

  const headerIndex = lines.findIndex((line) => getSearchHeaderStarts(line).length >= 3);
  if (headerIndex < 0) {
    return [];
  }

  const columns = getSearchHeaderStarts(lines[headerIndex]);
  const dataLines = lines.slice(headerIndex + 1).filter((line) => !/^\s*-{4,}\s*$/.test(line));
  const rows = [];

  for (const line of dataLines) {
    if (!line.trim() || isWingetMessageLine(line)) {
      continue;
    }

    const parsedLine = parseSearchDataLine(line);
    if (parsedLine) {
      rows.push(parsedLine);
      continue;
    }

    const row = {};
    for (let index = 0; index < columns.length; index += 1) {
      const column = columns[index];
      row[column.key] = getFixedValue(line, column, columns[index + 1]);
    }

    if (!row.id || !row.version || !isPackageId(row.id)) {
      continue;
    }

    rows.push({
      name: row.name || row.id,
      id: row.id,
      version: row.version,
      source: row.source || ''
    });
  }

  return rows;
}

function resolvePackageIdFromSearchOutput(output, prefix, source = '', name = '') {
  const normalizedPrefix = String(prefix ?? '').trim().toLowerCase();
  const normalizedSource = String(source ?? '').trim().toLowerCase();
  const normalizedNamePrefixes = getSearchNameMatchPrefixes(name);
  if (!normalizedPrefix) {
    return null;
  }

  const candidates = parseWingetSearchRows(output).filter((row) => {
    const id = String(row.id ?? '');
    const rowSource = String(row.source ?? '').trim().toLowerCase();
    const rowName = normalizeSearchName(row.name);

    return (
      id &&
      !hasTruncatedMarker(id) &&
      id.toLowerCase().startsWith(normalizedPrefix) &&
      (
        normalizedNamePrefixes.length === 0 ||
        normalizedNamePrefixes.some((namePrefix) => rowName.startsWith(namePrefix))
      ) &&
      (!normalizedSource || !rowSource || rowSource === normalizedSource)
    );
  });
  const uniqueIds = [...new Set(candidates.map((row) => row.id))];

  return uniqueIds.length === 1 ? uniqueIds[0] : null;
}

function versionsMatch(a, b) {
  const x = getTruncatedPrefix(a);
  const y = getTruncatedPrefix(b);
  if (!x || !y) {
    return false;
  }
  return x === y || x.startsWith(y) || y.startsWith(x);
}

// Resolves a truncated package id against `winget list` (installed packages)
// output. This is more reliable than a catalog search for upgradable packages:
// the catalog may hold several same-prefix variants (e.g. VCRedist x64/x86)
// that share a version and whose catalog name differs from the installed name,
// but the installed list only contains what is actually installed and carries
// the installed/available versions to disambiguate. parseWingetUpgradeRows
// keeps only rows that have an available upgrade, so same-prefix packages that
// are already current drop out on their own.
function resolvePackageIdFromListOutput(
  output,
  prefix,
  source = '',
  installedVersion = '',
  availableVersion = ''
) {
  const normalizedPrefix = String(prefix ?? '').trim().toLowerCase();
  if (!normalizedPrefix) {
    return null;
  }

  const normalizedSource = String(source ?? '').trim().toLowerCase();
  const candidates = parseWingetUpgradeRows(output).filter((row) => {
    const id = String(row.id ?? '');
    const rowSource = String(row.source ?? '').trim().toLowerCase();

    return (
      id &&
      !hasTruncatedMarker(id) &&
      id.toLowerCase().startsWith(normalizedPrefix) &&
      (!normalizedSource || !rowSource || rowSource === normalizedSource)
    );
  });

  if (candidates.length === 0) {
    return null;
  }

  let matches = candidates;
  if (matches.length > 1 && installedVersion) {
    const byInstalled = matches.filter((row) =>
      versionsMatch(row.installedVersion, installedVersion)
    );
    if (byInstalled.length > 0) {
      matches = byInstalled;
    }
  }
  if (matches.length > 1 && availableVersion) {
    const byAvailable = matches.filter((row) =>
      versionsMatch(row.availableVersion, availableVersion)
    );
    if (byAvailable.length > 0) {
      matches = byAvailable;
    }
  }

  const uniqueIds = [...new Set(matches.map((row) => row.id))];
  return uniqueIds.length === 1 ? uniqueIds[0] : null;
}

// Decodes a `winget export` output file. winget writes UTF-8, but guard against
// a UTF-16 BOM so an encoding quirk does not silently disable export-based
// resolution by turning the file into unparseable JSON.
function decodeWingetExportBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    return String(buffer ?? '');
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.toString('utf16le');
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer);
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  return buffer.toString('utf8');
}

// Parses `winget export --include-versions` JSON into a flat list of installed
// packages. Unlike the human-readable tables, export emits full, untruncated
// PackageIdentifiers, so it is the most reliable source for resolving a
// truncated upgrade-list id.
function parseWingetExportPackages(jsonText) {
  let parsed;
  try {
    const text = String(jsonText ?? '');
    parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return [];
  }

  const sources = Array.isArray(parsed?.Sources) ? parsed.Sources : [];
  const packages = [];

  for (const source of sources) {
    const sourceName = String(source?.SourceDetails?.Name ?? '').trim();
    const entries = Array.isArray(source?.Packages) ? source.Packages : [];

    for (const entry of entries) {
      const id = String(entry?.PackageIdentifier ?? '').trim();
      if (!id) {
        continue;
      }

      packages.push({
        id,
        version: String(entry?.Version ?? '').trim(),
        source: sourceName
      });
    }
  }

  return packages;
}

// Resolves a truncated upgrade-list id against the installed packages reported
// by `winget export`. Export carries full ids plus the installed version, which
// disambiguates same-prefix variants (e.g. the VCRedist x64/x86 pair) that the
// truncated table output cannot tell apart.
function resolvePackageIdFromExport(exportPackages, prefix, source = '', installedVersion = '') {
  const normalizedPrefix = String(prefix ?? '').trim().toLowerCase();
  if (!normalizedPrefix) {
    return null;
  }

  const normalizedSource = String(source ?? '').trim().toLowerCase();
  let matches = (Array.isArray(exportPackages) ? exportPackages : []).filter((pkg) => {
    const id = String(pkg?.id ?? '');
    const pkgSource = String(pkg?.source ?? '').trim().toLowerCase();

    return (
      id &&
      !hasTruncatedMarker(id) &&
      id.toLowerCase().startsWith(normalizedPrefix) &&
      (!normalizedSource || !pkgSource || pkgSource === normalizedSource)
    );
  });

  // Whenever the installed version is known, require it to match — even for a
  // single candidate. Export and the upgrade table both report winget's
  // installed version, so they are equal for the real package; demanding a
  // match stops a same-prefix sibling (e.g. if export omits the real package)
  // from being upgraded by mistake. Exact equality is required unless the
  // upgrade table itself truncated the version, where prefix matching is the
  // best available signal.
  if (installedVersion) {
    const installedTruncated = hasTruncatedMarker(installedVersion);
    const target = String(installedVersion).trim();
    matches = matches.filter((pkg) =>
      installedTruncated
        ? versionsMatch(pkg.version, installedVersion)
        : String(pkg.version).trim() === target
    );
  }

  const uniqueIds = [...new Set(matches.map((pkg) => pkg.id))];
  return uniqueIds.length === 1 ? uniqueIds[0] : null;
}

function toCount(value) {
  const normalized = String(value ?? '').replace(/,/g, '');
  const count = Number.parseInt(normalized, 10);
  return Number.isFinite(count) ? count : null;
}

function parseWingetUpgradeMetadata(output) {
  const lines = sanitizeWingetOutput(output).split(/\r?\n/);
  let declaredUpgradeCount = null;
  let unknownVersionCount = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      continue;
    }

    if (/사용 가능한 업그레이드가 없습니다|no available upgrades?|no newer package versions/i.test(line)) {
      declaredUpgradeCount = 0;
      continue;
    }

    const koreanUpgrade = line.match(/(\d[\d,]*)\s*(?:개\s*)?업그레이드(?:를|가)?\s*(?:사용\s*가능|사용할 수 있습니다)/);
    const englishUpgrade = line.match(/(\d[\d,]*)\s+upgrades?\s+available/i);
    const upgradeMatch = koreanUpgrade || englishUpgrade;

    if (upgradeMatch) {
      declaredUpgradeCount = toCount(upgradeMatch[1]);
      continue;
    }

    const koreanUnknown = line.match(/(\d[\d,]*)\s*(?:개\s*)?패키지(?:에|가|는)?.*확인할 수 없는\s+버전/);
    const englishUnknown = line.match(/(\d[\d,]*)\s+packages?.*version numbers?.*cannot be determined/i);
    const unknownMatch = koreanUnknown || englishUnknown;

    if (unknownMatch) {
      unknownVersionCount = toCount(unknownMatch[1]) ?? unknownVersionCount;
    }
  }

  return {
    declaredUpgradeCount,
    unknownVersionCount
  };
}

function isWingetMessageLine(line) {
  return (
    /업그레이드(?:를|가)?\s*(?:사용\s*가능|사용할 수 있습니다)/.test(line) ||
    /upgrades?\s+available/i.test(line) ||
    /확인할 수 없는\s+버전/.test(line) ||
    /version numbers?.*cannot be determined/i.test(line) ||
    /--include-unknown/i.test(line) ||
    /사용 가능한 업그레이드가 없습니다|no available upgrades?|no newer package versions/i.test(line)
  );
}

function parseWingetUpgradeRows(output) {
  const lines = sanitizeWingetOutput(output)
    .split(/\r?\n/)
    .map((line) => line.trimEnd());

  const headerIndex = lines.findIndex((line) => {
    const columns = getHeaderStarts(line);
    return columns.length >= 4;
  });

  if (headerIndex < 0) {
    return [];
  }

  const columns = getHeaderStarts(lines[headerIndex]);
  const hasSourceColumn = columns.some((column) => column.key === 'source');
  const dataLines = lines.slice(headerIndex + 1).filter((line) => !/^\s*-{4,}\s*$/.test(line));
  const rows = [];

  for (const line of dataLines) {
    if (!line.trim()) {
      continue;
    }

    if (isWingetMessageLine(line)) {
      continue;
    }

    const parsedLine = parseDataLine(line, { allowMissingSource: !hasSourceColumn });
    if (parsedLine) {
      rows.push(parsedLine);
      continue;
    }

    const row = {};
    for (let index = 0; index < columns.length; index += 1) {
      const column = columns[index];
      row[column.key] = getFixedValue(line, column, columns[index + 1]);
    }

    if (!row.id || !row.installedVersion || !row.availableVersion) {
      continue;
    }

    rows.push({
      name: row.name || row.id,
      id: row.id,
      installedVersion: row.installedVersion,
      availableVersion: row.availableVersion,
      source: row.source || ''
    });
  }

  return rows;
}

function parseWingetUpgradeOutput(output) {
  return parseWingetUpgradeRows(output);
}

function parseWingetUpgradeResult(output) {
  const packages = parseWingetUpgradeRows(output);
  const metadata = parseWingetUpgradeMetadata(output);

  return {
    packages,
    ...metadata,
    parsedCount: packages.length,
    countMismatch:
      metadata.declaredUpgradeCount !== null && metadata.declaredUpgradeCount !== packages.length
  };
}

function isFailureDetailNoise(line) {
  return (
    /^[-\\/|]$/.test(line) ||
    /^찾음 .+\[.+\]\s+버전\s+/i.test(line) ||
    /^Found .+\[.+\]\s+Version\s+/i.test(line) ||
    /라이선스는 그 소유자가 사용자에게 부여했습니다/.test(line) ||
    /Microsoft는 타사 패키지에 대한 책임을 지지/.test(line) ||
    /The license for this application/i.test(line) ||
    /Microsoft is not responsible for/i.test(line) ||
    /설치 관리자 해시를 확인했습니다/.test(line) ||
    /Installer hash verified/i.test(line) ||
    /패키지 제거를 시작하는 중/.test(line) ||
    /Starting package uninstall/i.test(line) ||
    /^다운로드\s+/.test(line) ||
    /^Downloading\s+/i.test(line)
  );
}

function isHighSignalFailureLine(line) {
  return (
    /설치 종료 코드로 인해/.test(line) ||
    /MsiExec .*failed:\s*-?\d+/i.test(line) ||
    /적용 가능한 업그레이드를 찾을 수 없습니다/.test(line) ||
    /시스템 또는 요구 사항에는 적용되지 않습니다/.test(line) ||
    /No applicable upgrade found/i.test(line) ||
    /not applicable to your system or requirements/i.test(line) ||
    /failed|failure|error/i.test(line) ||
    /실패|오류/.test(line)
  );
}

function uniqueLines(lines) {
  const seen = new Set();
  return lines.filter((line) => {
    if (seen.has(line)) {
      return false;
    }

    seen.add(line);
    return true;
  });
}

function summarizeWingetFailure(result, options = {}) {
  if (result?.ok) {
    return '';
  }

  const maxLines = Number.isInteger(options.maxLines) ? options.maxLines : 3;
  const output = [result?.stdout, result?.stderr].filter(Boolean).join('\n');
  const lines = uniqueLines(
    sanitizeWingetOutput(output)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  );
  const signalLines = lines.filter((line) => isHighSignalFailureLine(line));
  const detailLines =
    signalLines.length > 0
      ? signalLines.slice(-maxLines)
      : lines.filter((line) => !isFailureDetailNoise(line)).slice(-maxLines);
  const detail = detailLines.join('\n').trim();

  if (detail) {
    return detail;
  }

  if (result?.code !== undefined && result?.code !== null) {
    return `winget exited with code ${result.code}`;
  }

  return 'winget failed without a detailed error message.';
}

function classifyWingetFailure(result) {
  if (result?.ok) {
    return '';
  }

  const output = [result?.stdout, result?.stderr, summarizeWingetFailure(result)]
    .filter(Boolean)
    .join('\n');

  if (
    /Error\s+1730/i.test(output) ||
    /must be an Administrator/i.test(output) ||
    /관리자.*(?:제거|권한|실행)/.test(output)
  ) {
    return 'requires-admin';
  }

  if (
    /설치 종료 코드로 인해/.test(output) ||
    /MsiExec .*failed:\s*-?\d+/i.test(output) ||
    /\b1603\b/.test(output)
  ) {
    return 'installer';
  }

  if (
    /입력 조건과 일치하는 설치된 패키지를 찾을 수 없습니다/.test(output) ||
    /No installed package found matching input criteria/i.test(output)
  ) {
    return 'not-found';
  }

  if (
    /적용 가능한 업그레이드를 찾을 수 없습니다/.test(output) ||
    /시스템 또는 요구 사항에는 적용되지 않습니다/.test(output) ||
    /No applicable upgrade found/i.test(output) ||
    /not applicable to your system or requirements/i.test(output)
  ) {
    return 'not-applicable';
  }

  if (/hash/i.test(output) || /해시/.test(output)) {
    return 'hash';
  }

  return 'generic';
}

function buildListArgs(options = {}) {
  const args = ['upgrade', '--accept-source-agreements'];

  if (options.includeUnknown) {
    args.push('--include-unknown');
  }

  if (options.includePinned) {
    args.push('--include-pinned');
  }

  return args;
}

function buildSearchArgs(prefix, source = '') {
  if (!prefix || typeof prefix !== 'string') {
    throw new Error('A package id prefix is required.');
  }

  const args = ['search', '--id', prefix];

  if (source) {
    args.push('--source', source);
  }

  args.push('--accept-source-agreements', '--disable-interactivity');

  return args;
}

function buildListByIdArgs(prefix, source = '') {
  if (!prefix || typeof prefix !== 'string') {
    throw new Error('A package id prefix is required.');
  }

  const args = ['list', '--id', prefix];

  if (source) {
    args.push('--source', source);
  }

  args.push('--accept-source-agreements', '--disable-interactivity');

  return args;
}

function buildExportArgs(outputPath) {
  if (!outputPath || typeof outputPath !== 'string') {
    throw new Error('An export output path is required.');
  }

  return [
    'export',
    '--output',
    outputPath,
    '--include-versions',
    '--accept-source-agreements',
    '--disable-interactivity'
  ];
}

function buildUpgradeArgs(id, options = {}) {
  if (!id || typeof id !== 'string') {
    throw new Error('A package id is required.');
  }

  const args = [
    'upgrade',
    '--id',
    id,
    '--exact',
    '--accept-package-agreements',
    '--accept-source-agreements',
    '--disable-interactivity'
  ];

  if (options.silent) {
    args.push('--silent');
  }

  if (options.includeUnknown) {
    args.push('--include-unknown');
  }

  if (options.includePinned) {
    args.push('--include-pinned');
  }

  return args;
}

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
  buildExportArgs,
  buildListArgs,
  buildListByIdArgs,
  buildSearchArgs,
  buildUpgradeArgs,
  classifyWingetFailure,
  createTerminalLogProcessor,
  createWingetRunner,
  decodeWingetExportBuffer,
  parseWingetExportPackages,
  parseWingetUpgradeOutput,
  parseWingetUpgradeResult,
  resolvePackageIdFromExport,
  resolvePackageIdFromListOutput,
  resolvePackageIdFromSearchOutput,
  sanitizeWingetOutput,
  summarizeWingetFailure
};
