// Pure parsing and text utilities for winget output: table/search/export
// parsing, display-width handling, truncation/version helpers, and failure
// classification. No process or filesystem access — safe to unit test directly.

// Built from char codes (not \u escapes) so the source stays free of invisible
// control characters: ESC starts ANSI CSI sequences, backspace appears in some
// progress output.
const ESC = String.fromCharCode(0x1b);
const BACKSPACE = String.fromCharCode(0x08);
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, 'g');
const CONTROL_CHARS_PATTERN = new RegExp(`[${BACKSPACE}${ESC}]`, 'g');
const TRUNCATION_PATTERN = /…|\.\.\./;

function stripTerminalControlSequences(text) {
  return String(text ?? '')
    .replace(ANSI_PATTERN, '')
    .replace(CONTROL_CHARS_PATTERN, '');
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

function versionsMatch(a, b) {
  const x = getTruncatedPrefix(a);
  const y = getTruncatedPrefix(b);
  if (!x || !y) {
    return false;
  }
  return x === y || x.startsWith(y) || y.startsWith(x);
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

module.exports = {
  sanitizeWingetOutput,
  createTerminalLogProcessor,
  isPackageId,
  hasTruncatedMarker,
  getTruncatedPrefix,
  normalizeSearchName,
  getSearchNameMatchPrefixes,
  versionsMatch,
  parseWingetSearchRows,
  parseWingetUpgradeRows,
  parseWingetUpgradeOutput,
  parseWingetUpgradeResult,
  parseWingetUpgradeMetadata,
  isWingetMessageLine,
  decodeWingetExportBuffer,
  parseWingetExportPackages,
  summarizeWingetFailure,
  classifyWingetFailure
};
