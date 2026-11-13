//! Pure parsing and text utilities for winget output: table/search/export
//! parsing, display-width handling, log streaming, failure classification.
//! No process or filesystem access.

use regex::Regex;
use serde::Serialize;
use std::sync::LazyLock;

static ANSI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b\[[0-?]*[ -/]*[@-~]").unwrap());
static CONTROL_CHARS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\x08\x1b]").unwrap());
static TRUNCATION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"…|\.\.\.").unwrap());
static DASH_LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*-{4,}\s*$").unwrap());
static PACKAGE_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._+-]{2,}$").unwrap());
static KNOWN_SOURCE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^(winget|msstore)$").unwrap());

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).unwrap()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpgradeRow {
    pub name: String,
    pub id: String,
    pub installed_version: String,
    pub available_version: String,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpgradeResult {
    pub packages: Vec<UpgradeRow>,
    pub declared_upgrade_count: Option<u32>,
    pub unknown_version_count: u32,
    pub parsed_count: usize,
    pub count_mismatch: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LogEntry {
    pub text: String,
    pub replace: bool,
}

pub fn strip_terminal_control_sequences(text: &str) -> String {
    let without_ansi = ANSI.replace_all(text, "");
    CONTROL_CHARS.replace_all(&without_ansi, "").into_owned()
}

/// winget sometimes emits localized messages double-encoded (UTF-8 bytes
/// re-read as Latin-1, including invisible C1 controls). Repair such a line by
/// round-tripping through Latin-1; keep the original if it is not valid UTF-8.
pub fn repair_double_encoded_utf8(line: &str) -> String {
    let has_c1 = line.chars().any(|c| ('\u{80}'..='\u{9f}').contains(&c));
    let latin1_only = line.chars().all(|c| (c as u32) <= 0xff);
    if !has_c1 || !latin1_only {
        return line.to_string();
    }
    let bytes: Vec<u8> = line.chars().map(|c| c as u32 as u8).collect();
    match String::from_utf8(bytes) {
        Ok(decoded) if !decoded.contains(char::REPLACEMENT_CHARACTER) => decoded,
        _ => line.to_string(),
    }
}

pub fn sanitize_winget_output(text: &str) -> String {
    let stripped = strip_terminal_control_sequences(text)
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let trimmed = stripped.trim_start_matches('\n').trim_end();
    trimmed
        .split('\n')
        .map(repair_double_encoded_utf8)
        .collect::<Vec<_>>()
        .join("\n")
}

/// Splits streamed winget output into log entries. A carriage return marks the
/// next frame as a replacement of the previous line (progress spinners/bars).
#[derive(Default)]
pub struct TerminalLogProcessor {
    line: String,
    has_replace_target: bool,
}

impl TerminalLogProcessor {
    pub fn new() -> Self {
        Self::default()
    }

    fn emit_buffered_line(&mut self, replace: bool, out: &mut Vec<LogEntry>) -> bool {
        let text = repair_double_encoded_utf8(&self.line).trim().to_string();
        self.line.clear();
        if text.is_empty() {
            return false;
        }
        out.push(LogEntry { text, replace });
        true
    }

    fn handle_cr(&mut self, out: &mut Vec<LogEntry>) {
        let replace = self.has_replace_target;
        let emitted = self.emit_buffered_line(replace, out);
        self.has_replace_target = emitted || self.has_replace_target;
    }

    /// Emits each frame as soon as its '\r' arrives, so progress bars update
    /// without lag. A "\r\n" split across chunks is still harmless: the '\r'
    /// emits the line and the following '\n' only finds an empty buffer.
    pub fn write(&mut self, chunk: &str) -> Vec<LogEntry> {
        let mut out = Vec::new();
        let text = strip_terminal_control_sequences(chunk).replace("\r\n", "\n");
        for ch in text.chars() {
            match ch {
                '\r' => self.handle_cr(&mut out),
                '\n' => {
                    let replace = self.has_replace_target;
                    self.emit_buffered_line(replace, &mut out);
                    self.has_replace_target = false;
                }
                _ => self.line.push(ch),
            }
        }
        out
    }

    pub fn flush(&mut self) -> Vec<LogEntry> {
        let mut out = Vec::new();
        let replace = self.has_replace_target;
        self.emit_buffered_line(replace, &mut out);
        self.has_replace_target = false;
        out
    }
}

/// Appends `entries` to a pending batch. A replace entry only rewrites the last
/// line, so it overwrites the last pending entry's text instead of piling up
/// frames the UI would immediately throw away.
pub fn coalesce_log_entries(pending: &mut Vec<LogEntry>, entries: Vec<LogEntry>) {
    for entry in entries {
        match pending.last_mut() {
            Some(last) if entry.replace => last.text = entry.text,
            _ => pending.push(entry),
        }
    }
}

fn is_combining(cp: u32) -> bool {
    (0x0300..=0x036f).contains(&cp)
        || (0x1ab0..=0x1aff).contains(&cp)
        || (0x1dc0..=0x1dff).contains(&cp)
        || (0x20d0..=0x20ff).contains(&cp)
        || (0xfe20..=0xfe2f).contains(&cp)
}

fn is_wide(cp: u32) -> bool {
    (0x1100..=0x115f).contains(&cp)
        || cp == 0x2329
        || cp == 0x232a
        || ((0x2e80..=0xa4cf).contains(&cp) && cp != 0x303f)
        || (0xac00..=0xd7a3).contains(&cp)
        || (0xf900..=0xfaff).contains(&cp)
        || (0xfe10..=0xfe19).contains(&cp)
        || (0xfe30..=0xfe6f).contains(&cp)
        || (0xff00..=0xff60).contains(&cp)
        || (0xffe0..=0xffe6).contains(&cp)
}

fn char_width(c: char) -> usize {
    let cp = c as u32;
    if cp == 0 || is_combining(cp) {
        0
    } else if is_wide(cp) {
        2
    } else {
        1
    }
}

pub fn display_width(text: &str) -> usize {
    text.chars().map(char_width).sum()
}

/// Byte index of the first char at or past `target` display columns.
fn byte_index_at_column(line: &str, target: usize) -> usize {
    let mut column = 0;
    for (index, c) in line.char_indices() {
        if column >= target {
            return index;
        }
        column += char_width(c);
    }
    line.len()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Key {
    Name,
    Id,
    Installed,
    Available,
    Source,
}

#[derive(Debug, Clone, Copy)]
struct Column {
    key: Key,
    start: usize,
}

fn find_header_label_start(header: &str, labels: &[&str]) -> Option<usize> {
    labels
        .iter()
        .filter_map(|label| header.find(label).map(|i| display_width(&header[..i])))
        .min()
}

fn header_starts(header: &str) -> Vec<Column> {
    let sets: [&[(Key, &[&str])]; 2] = [
        &[
            (Key::Name, &["Name"]),
            (Key::Id, &["Id", "ID"]),
            (Key::Installed, &["Version"]),
            (Key::Available, &["Available"]),
            (Key::Source, &["Source"]),
        ],
        &[
            (Key::Name, &["이름"]),
            (Key::Id, &["장치 ID", "ID"]),
            (Key::Installed, &["버전"]),
            (Key::Available, &["사용 가능"]),
            (Key::Source, &["원본"]),
        ],
    ];

    for set in sets {
        let mut columns: Vec<Column> = set
            .iter()
            .filter_map(|(key, labels)| {
                find_header_label_start(header, labels).map(|start| Column { key: *key, start })
            })
            .collect();
        columns.sort_by_key(|c| c.start);
        let has = |k: Key| columns.iter().any(|c| c.key == k);
        if has(Key::Name) && has(Key::Id) && has(Key::Installed) && has(Key::Available) {
            return columns;
        }
    }
    Vec::new()
}

fn fixed_value(line: &str, column: &Column, next: Option<&Column>) -> String {
    if display_width(line) <= column.start {
        return String::new();
    }
    let start = byte_index_at_column(line, column.start);
    let end = next.map_or(line.len(), |n| byte_index_at_column(line, n.start));
    line[start..end.max(start)].trim().to_string()
}

pub fn is_package_id(value: &str) -> bool {
    PACKAGE_ID.is_match(value)
}

fn parse_data_line(line: &str, allow_missing_source: bool) -> Option<UpgradeRow> {
    let tokens: Vec<&str> = line.split_whitespace().collect();
    let n = tokens.len();

    if n >= 5 && KNOWN_SOURCE.is_match(tokens[n - 1]) {
        let name = tokens[..n - 4].join(" ");
        let id = tokens[n - 4];
        if !name.is_empty() && is_package_id(id) {
            return Some(UpgradeRow {
                name,
                id: id.to_string(),
                installed_version: tokens[n - 3].to_string(),
                available_version: tokens[n - 2].to_string(),
                source: tokens[n - 1].to_string(),
            });
        }
    }

    if allow_missing_source && n >= 4 {
        let name = tokens[..n - 3].join(" ");
        let id = tokens[n - 3];
        if !name.is_empty() && is_package_id(id) {
            return Some(UpgradeRow {
                name,
                id: id.to_string(),
                installed_version: tokens[n - 2].to_string(),
                available_version: tokens[n - 1].to_string(),
                source: String::new(),
            });
        }
    }
    None
}

pub fn has_truncated_marker(value: &str) -> bool {
    TRUNCATION.is_match(value)
}

pub fn truncated_prefix(value: &str) -> String {
    TRUNCATION.split(value).next().unwrap_or("").trim().to_string()
}

static NO_UPGRADES: LazyLock<Regex> = LazyLock::new(|| {
    re(r"(?i)사용 가능한 업그레이드가 없습니다|no available upgrades?|no newer package versions")
});

fn to_count(value: &str) -> Option<u32> {
    value.replace(',', "").parse().ok()
}

pub fn parse_upgrade_metadata(output: &str) -> (Option<u32>, u32) {
    static KO_UPGRADE: LazyLock<Regex> = LazyLock::new(|| {
        re(r"(\d[\d,]*)\s*(?:개\s*)?업그레이드(?:를|가)?\s*(?:사용\s*가능|사용할 수 있습니다)")
    });
    static EN_UPGRADE: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)(\d[\d,]*)\s+upgrades?\s+available"));
    static KO_UNKNOWN: LazyLock<Regex> =
        LazyLock::new(|| re(r"(\d[\d,]*)\s*(?:개\s*)?패키지(?:에|가|는)?.*확인할 수 없는\s+버전"));
    static EN_UNKNOWN: LazyLock<Regex> =
        LazyLock::new(|| re(r"(?i)(\d[\d,]*)\s+packages?.*version numbers?.*cannot be determined"));

    let mut declared = None;
    let mut unknown = 0;
    for raw in sanitize_winget_output(output).lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if NO_UPGRADES.is_match(line) {
            declared = Some(0);
            continue;
        }
        if let Some(c) = KO_UPGRADE.captures(line).or_else(|| EN_UPGRADE.captures(line)) {
            declared = to_count(&c[1]);
            continue;
        }
        if let Some(c) = KO_UNKNOWN.captures(line).or_else(|| EN_UNKNOWN.captures(line)) {
            unknown = to_count(&c[1]).unwrap_or(unknown);
        }
    }
    (declared, unknown)
}

pub fn is_winget_message_line(line: &str) -> bool {
    static PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
        [
            r"업그레이드(?:를|가)?\s*(?:사용\s*가능|사용할 수 있습니다)",
            r"(?i)upgrades?\s+available",
            r"확인할 수 없는\s+버전",
            r"(?i)version numbers?.*cannot be determined",
            r"(?i)--include-unknown",
        ]
        .iter()
        .map(|p| re(p))
        .collect()
    });
    PATTERNS.iter().any(|p| p.is_match(line)) || NO_UPGRADES.is_match(line)
}

pub fn parse_upgrade_rows(output: &str) -> Vec<UpgradeRow> {
    let sanitized = sanitize_winget_output(output);
    let lines: Vec<&str> = sanitized.lines().map(str::trim_end).collect();

    let Some(header_index) = lines.iter().position(|l| header_starts(l).len() >= 4) else {
        return Vec::new();
    };
    let columns = header_starts(lines[header_index]);
    let has_source = columns.iter().any(|c| c.key == Key::Source);
    let mut rows = Vec::new();

    for line in &lines[header_index + 1..] {
        if DASH_LINE.is_match(line) || line.trim().is_empty() || is_winget_message_line(line) {
            continue;
        }
        if let Some(row) = parse_data_line(line, !has_source) {
            rows.push(row);
            continue;
        }

        let value = |key: Key| -> String {
            columns
                .iter()
                .position(|c| c.key == key)
                .map(|i| fixed_value(line, &columns[i], columns.get(i + 1)))
                .unwrap_or_default()
        };
        let id = value(Key::Id);
        let installed = value(Key::Installed);
        let available = value(Key::Available);
        if id.is_empty() || installed.is_empty() || available.is_empty() {
            continue;
        }
        let name = value(Key::Name);
        rows.push(UpgradeRow {
            name: if name.is_empty() { id.clone() } else { name },
            id,
            installed_version: installed,
            available_version: available,
            source: value(Key::Source),
        });
    }
    rows
}

pub fn parse_upgrade_result(output: &str) -> UpgradeResult {
    let packages = parse_upgrade_rows(output);
    let (declared, unknown) = parse_upgrade_metadata(output);
    let parsed_count = packages.len();
    UpgradeResult {
        packages,
        declared_upgrade_count: declared,
        unknown_version_count: unknown,
        parsed_count,
        count_mismatch: declared.is_some_and(|d| d as usize != parsed_count),
    }
}

fn matches_any(patterns: &[Regex], text: &str) -> bool {
    patterns.iter().any(|p| p.is_match(text))
}

fn is_failure_detail_noise(line: &str) -> bool {
    static P: LazyLock<Vec<Regex>> = LazyLock::new(|| {
        [
            r"^[-\\/|]$",
            r"(?i)^찾음 .+\[.+\]\s+버전\s+",
            r"(?i)^Found .+\[.+\]\s+Version\s+",
            r"라이선스는 그 소유자가 사용자에게 부여했습니다",
            r"Microsoft는 타사 패키지에 대한 책임을 지지",
            r"(?i)The license for this application",
            r"(?i)Microsoft is not responsible for",
            r"설치 관리자 해시를 확인했습니다",
            r"(?i)Installer hash verified",
            r"패키지 제거를 시작하는 중",
            r"(?i)Starting package uninstall",
            r"^다운로드\s+",
            r"(?i)^Downloading\s+",
        ]
        .iter()
        .map(|p| re(p))
        .collect()
    });
    matches_any(&P, line)
}

fn is_high_signal_failure_line(line: &str) -> bool {
    static P: LazyLock<Vec<Regex>> = LazyLock::new(|| {
        [
            r"설치 종료 코드로 인해",
            r"(?i)MsiExec .*failed:\s*-?\d+",
            r"적용 가능한 업그레이드를 찾을 수 없습니다",
            r"시스템 또는 요구 사항에는 적용되지 않습니다",
            r"(?i)No applicable upgrade found",
            r"(?i)not applicable to your system or requirements",
            r"(?i)failed|failure|error",
            r"실패|오류",
        ]
        .iter()
        .map(|p| re(p))
        .collect()
    });
    matches_any(&P, line)
}

/// Minimal view of a finished winget process used by failure helpers.
pub struct RunOutput<'a> {
    pub ok: bool,
    pub code: Option<i32>,
    pub stdout: &'a str,
    pub stderr: &'a str,
}

pub fn summarize_failure(result: &RunOutput, max_lines: usize) -> String {
    if result.ok {
        return String::new();
    }
    let joined = [result.stdout, result.stderr]
        .iter()
        .filter(|s| !s.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join("\n");
    let mut seen = std::collections::HashSet::new();
    let lines: Vec<String> = sanitize_winget_output(&joined)
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty() && seen.insert(l.clone()))
        .collect();

    let signal: Vec<&String> = lines.iter().filter(|l| is_high_signal_failure_line(l)).collect();
    let pool: Vec<&String> = if signal.is_empty() {
        lines.iter().filter(|l| !is_failure_detail_noise(l)).collect()
    } else {
        signal
    };
    let start = pool.len().saturating_sub(max_lines);
    let detail = pool[start..]
        .iter()
        .map(|s| s.as_str())
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();

    if !detail.is_empty() {
        return detail;
    }
    match result.code {
        Some(code) => format!("winget exited with code {code}"),
        None => "winget failed without a detailed error message.".to_string(),
    }
}

pub fn classify_failure(result: &RunOutput) -> &'static str {
    if result.ok {
        return "";
    }
    let summary = summarize_failure(result, 3);
    let output = [result.stdout, result.stderr, summary.as_str()]
        .iter()
        .filter(|s| !s.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join("\n");

    static HASH: LazyLock<Vec<Regex>> = LazyLock::new(|| {
        [
            r"해시.*일치하지\s*않",
            r"해시가 매니페스트와 다",
            r"(?i)installer hash.*(?:does not match|mismatch)",
            r"(?i)hash.*does not match",
        ]
        .iter()
        .map(|p| re(p))
        .collect()
    });
    static ADMIN: LazyLock<Vec<Regex>> = LazyLock::new(|| {
        [r"(?i)Error\s+1730", r"(?i)must be an Administrator", r"관리자.*(?:제거|권한|실행)"]
            .iter()
            .map(|p| re(p))
            .collect()
    });
    static BUSY: LazyLock<Vec<Regex>> = LazyLock::new(|| {
        [
            r"다른 설치가 (?:이미 )?진행",
            r"(?i)another installation is (?:already )?in progress",
            r"(?i)(?:종료 코드로 인해 실패함|failed with exit code)\D{0,5}1618\b",
        ]
        .iter()
        .map(|p| re(p))
        .collect()
    });
    static INSTALLER: LazyLock<Vec<Regex>> = LazyLock::new(|| {
        [
            r"설치 종료 코드로 인해",
            r"설치 관리자가 종료 코드로 인해 실패함",
            r"(?i)installer failed with exit code",
            r"(?i)MsiExec .*failed:\s*-?\d+",
            r"\b1603\b",
        ]
        .iter()
        .map(|p| re(p))
        .collect()
    });
    static NOT_FOUND: LazyLock<Vec<Regex>> = LazyLock::new(|| {
        [
            r"입력 조건과 일치하는 설치된 패키지를 찾을 수 없습니다",
            r"(?i)No installed package found matching input criteria",
        ]
        .iter()
        .map(|p| re(p))
        .collect()
    });
    static TECH: LazyLock<Vec<Regex>> = LazyLock::new(|| {
        [r"설치 기술이 현재 설치된 버전과 다", r"(?i)install technology is different"]
            .iter()
            .map(|p| re(p))
            .collect()
    });
    static NOT_APPLICABLE: LazyLock<Vec<Regex>> = LazyLock::new(|| {
        [
            r"적용 가능한 업그레이드를 찾을 수 없습니다",
            r"시스템 또는 요구 사항에는 적용되지 않습니다",
            r"(?i)No applicable upgrade found",
            r"(?i)not applicable to your system or requirements",
        ]
        .iter()
        .map(|p| re(p))
        .collect()
    });
    static HASH_VERIFIED: LazyLock<Regex> =
        LazyLock::new(|| re(r"해시를 확인했습니다|(?i:installer hash verified)"));
    static LOOSE_HASH: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)hash|해시"));

    if matches_any(&HASH, &output) {
        return "hash";
    }
    if matches_any(&ADMIN, &output) {
        return "requires-admin";
    }
    if matches_any(&BUSY, &output) {
        return "installer-busy";
    }
    if matches_any(&INSTALLER, &output) {
        return "installer";
    }
    if matches_any(&NOT_FOUND, &output) {
        return "not-found";
    }
    if matches_any(&TECH, &output) {
        return "install-tech";
    }
    if matches_any(&NOT_APPLICABLE, &output) {
        return "not-applicable";
    }
    let without_verified = output
        .lines()
        .filter(|l| !HASH_VERIFIED.is_match(l))
        .collect::<Vec<_>>()
        .join("\n");
    if LOOSE_HASH.is_match(&without_verified) {
        return "hash";
    }
    "generic"
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchRow {
    pub name: String,
    pub id: String,
    pub version: String,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportPackage {
    pub id: String,
    pub version: String,
    pub source: String,
}

fn parse_search_data_line(line: &str) -> Option<SearchRow> {
    let tokens: Vec<&str> = line.split_whitespace().collect();
    let n = tokens.len();
    if n < 4 || !KNOWN_SOURCE.is_match(tokens[n - 1]) {
        return None;
    }
    let name = tokens[..n - 3].join(" ");
    let id = tokens[n - 3];
    if name.is_empty() || !is_package_id(id) {
        return None;
    }
    Some(SearchRow {
        name,
        id: id.to_string(),
        version: tokens[n - 2].to_string(),
        source: tokens[n - 1].to_string(),
    })
}

fn search_header_starts(header: &str) -> Vec<Column> {
    // Search tables reuse Installed for their single version column.
    let sets: [&[(Key, &[&str])]; 2] = [
        &[(Key::Name, &["Name"]), (Key::Id, &["Id", "ID"]), (Key::Installed, &["Version"]), (Key::Source, &["Source"])],
        &[(Key::Name, &["이름"]), (Key::Id, &["장치 ID", "ID"]), (Key::Installed, &["버전"]), (Key::Source, &["원본"])],
    ];
    for set in sets {
        let mut columns: Vec<Column> = set
            .iter()
            .filter_map(|(key, labels)| {
                find_header_label_start(header, labels).map(|start| Column { key: *key, start })
            })
            .collect();
        columns.sort_by_key(|c| c.start);
        let has = |k: Key| columns.iter().any(|c| c.key == k);
        if has(Key::Name) && has(Key::Id) && has(Key::Installed) {
            return columns;
        }
    }
    Vec::new()
}

pub fn parse_search_rows(output: &str) -> Vec<SearchRow> {
    let sanitized = sanitize_winget_output(output);
    let lines: Vec<&str> = sanitized.lines().map(str::trim_end).collect();
    let Some(header_index) = lines.iter().position(|l| search_header_starts(l).len() >= 3) else {
        return Vec::new();
    };
    let columns = search_header_starts(lines[header_index]);
    let mut rows = Vec::new();

    for line in &lines[header_index + 1..] {
        if DASH_LINE.is_match(line) || line.trim().is_empty() || is_winget_message_line(line) {
            continue;
        }
        if let Some(row) = parse_search_data_line(line) {
            rows.push(row);
            continue;
        }
        let value = |key: Key| -> String {
            columns
                .iter()
                .position(|c| c.key == key)
                .map(|i| fixed_value(line, &columns[i], columns.get(i + 1)))
                .unwrap_or_default()
        };
        let id = value(Key::Id);
        let version = value(Key::Installed);
        if id.is_empty() || version.is_empty() || !is_package_id(&id) {
            continue;
        }
        let name = value(Key::Name);
        rows.push(SearchRow {
            name: if name.is_empty() { id.clone() } else { name },
            id,
            version,
            source: value(Key::Source),
        });
    }
    rows
}

pub fn versions_match(a: &str, b: &str) -> bool {
    let x = truncated_prefix(a);
    let y = truncated_prefix(b);
    !x.is_empty() && !y.is_empty() && (x == y || x.starts_with(&y) || y.starts_with(&x))
}

pub fn normalize_search_name(value: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    static NON_ALNUM: LazyLock<Regex> = LazyLock::new(|| re(r"[^\p{L}\p{N}]+"));
    let normalized: String = value.nfkc().collect::<String>().to_lowercase();
    NON_ALNUM.replace_all(&normalized, "").into_owned()
}

pub fn search_name_match_prefixes(value: &str) -> Vec<String> {
    static TRAILING_VERSION: LazyLock<Regex> =
        LazyLock::new(|| re(r"(?i)\s+v?\d+(?:[._-]\d+)+(?:[-+][\p{L}\p{N}._-]+)?\s*$"));
    let prefix = truncated_prefix(value);
    let without_version = TRAILING_VERSION.replace(&prefix, "").into_owned();
    let mut out: Vec<String> = Vec::new();
    for candidate in [prefix, without_version] {
        let normalized = normalize_search_name(&candidate);
        if !normalized.is_empty() && !out.contains(&normalized) {
            out.push(normalized);
        }
    }
    out
}

/// Decodes a `winget export` file: UTF-8, with a guard for UTF-16 BOMs.
pub fn decode_export_bytes(bytes: &[u8]) -> String {
    let utf16 = |little: bool| -> String {
        let units: Vec<u16> = bytes[2..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|&pair| if little { u16::from_le_bytes(pair) } else { u16::from_be_bytes(pair) })
            .collect();
        String::from_utf16_lossy(&units)
    };
    match bytes {
        [0xff, 0xfe, ..] => utf16(true),
        [0xfe, 0xff, ..] => utf16(false),
        _ => String::from_utf8_lossy(bytes).into_owned(),
    }
}

pub fn strip_bom(text: &str) -> &str {
    let bom = char::from_u32(0xfeff).unwrap_or(' ');
    text.strip_prefix(bom).unwrap_or(text)
}

/// Parses `winget export --include-versions` JSON into installed packages.
pub fn parse_export_packages(json_text: &str) -> Vec<ExportPackage> {
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(strip_bom(json_text)) else {
        return Vec::new();
    };
    let mut packages = Vec::new();
    for source in parsed.get("Sources").and_then(|s| s.as_array()).into_iter().flatten() {
        let source_name = source
            .pointer("/SourceDetails/Name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        for entry in source.get("Packages").and_then(|p| p.as_array()).into_iter().flatten() {
            let id = entry.get("PackageIdentifier").and_then(|v| v.as_str()).unwrap_or("").trim();
            if id.is_empty() {
                continue;
            }
            packages.push(ExportPackage {
                id: id.to_string(),
                version: entry.get("Version").and_then(|v| v.as_str()).unwrap_or("").trim().to_string(),
                source: source_name.clone(),
            });
        }
    }
    packages
}

#[cfg(test)]
mod tests {
    use super::*;

    fn latin1_mojibake(s: &str) -> String {
        s.as_bytes().iter().map(|&b| b as char).collect()
    }

    #[test]
    fn parses_english_table() {
        let output = "
Name                           Id                           Version      Available    Source
------------------------------------------------------------------------------------------
Microsoft PowerToys            Microsoft.PowerToys          0.88.0       0.89.0       winget
Git                            Git.Git                      2.47.1       2.48.1       winget
2 upgrades available.
";
        let rows = parse_upgrade_rows(output);
        assert_eq!(
            rows,
            vec![
                UpgradeRow {
                    name: "Microsoft PowerToys".into(),
                    id: "Microsoft.PowerToys".into(),
                    installed_version: "0.88.0".into(),
                    available_version: "0.89.0".into(),
                    source: "winget".into(),
                },
                UpgradeRow {
                    name: "Git".into(),
                    id: "Git.Git".into(),
                    installed_version: "2.47.1".into(),
                    available_version: "2.48.1".into(),
                    source: "winget".into(),
                },
            ]
        );
        assert_eq!(parse_upgrade_result(output).declared_upgrade_count, Some(2));
    }

    #[test]
    fn parses_korean_device_id_header_with_truncated_names() {
        let output = "
이름                        장치 ID                     버전                        사용 가능                    원본
-----------------------------------------------------------------------------------------------------------------------
DBeaver 26.0.3              DBeaver.DBeaver.Community   26.0.3                      26.0.4                       winget
Miniforge3 24.11.3-0 (Pyth… CondaForge.Miniforge3       24.11.3-0                   26.3.2-0                     winget
Microsoft Visual Studio Co… Microsoft.VisualStudioCode  1.118.1                     1.119.0                      winget
15 업그레이드를 사용할 수 있습니다.
";
        let rows = parse_upgrade_rows(output);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[1].name, "Miniforge3 24.11.3-0 (Pyth…");
        assert_eq!(rows[1].id, "CondaForge.Miniforge3");
        assert_eq!(rows[2].available_version, "1.119.0");
    }

    #[test]
    fn falls_back_to_fixed_columns_for_truncated_ids() {
        let output = "\r   - \r   \\ \r   | \r   / \r이름                        장치 ID                     버전                        사용 가능                    원본
-----------------------------------------------------------------------------------------------------------------------
LibreOffice 26.2.2.2        TheDocumentFoundation.Libr… 26.2.2.2                    26.2.3.2                     winget
Warp                        Warp.Warp                   v0.2026.04.22.08.46.stable… v0.2026.04.29.08.57.stable_… winget
2 업그레이드를 사용할 수 있습니다.
";
        let result = parse_upgrade_result(output);
        assert_eq!(result.packages.len(), 2);
        assert!(!result.count_mismatch);
        assert_eq!(
            result.packages[0],
            UpgradeRow {
                name: "LibreOffice 26.2.2.2".into(),
                id: "TheDocumentFoundation.Libr…".into(),
                installed_version: "26.2.2.2".into(),
                available_version: "26.2.3.2".into(),
                source: "winget".into(),
            }
        );
        assert!(has_truncated_marker(&result.packages[0].id));
        assert_eq!(truncated_prefix(&result.packages[0].id), "TheDocumentFoundation.Libr");
    }

    #[test]
    fn parses_korean_unknown_version_metadata() {
        let output = "
이름          장치 ID     버전    사용 가능  원본
-------------------------------------------------
Zed           ZedIndustries.Zed 0.232.3 1.1.5 winget
1 업그레이드를 사용할 수 있습니다.
1 패키지에 확인할 수 없는 버전 번호가 있습니다. 모든 결과를 보려면 --include-unknown 사용하세요.
";
        let result = parse_upgrade_result(output);
        assert_eq!(result.packages.len(), 1);
        assert_eq!(result.declared_upgrade_count, Some(1));
        assert_eq!(result.unknown_version_count, 1);
    }

    #[test]
    fn ignores_non_table_output() {
        assert!(parse_upgrade_rows("사용 가능한 업그레이드가 없습니다.").is_empty());
        assert_eq!(parse_upgrade_metadata("사용 가능한 업그레이드가 없습니다.").0, Some(0));
    }

    #[test]
    fn strips_control_sequences() {
        let dirty = "\x1b[2K\rName Id Version Available Source\x1b[0m";
        assert_eq!(sanitize_winget_output(dirty), "Name Id Version Available Source");
    }

    #[test]
    fn emits_carriage_return_frames_as_replacements() {
        let mut p = TerminalLogProcessor::new();
        let mut entries = p.write("-\r");
        entries.extend(p.write("\\\r|\r"));
        entries.extend(p.write("찾음 Warp [Warp.Warp] 버전 v0\n"));
        entries.extend(p.flush());
        let got: Vec<(String, bool)> = entries.into_iter().map(|e| (e.text, e.replace)).collect();
        assert_eq!(
            got,
            vec![
                ("-".to_string(), false),
                ("\\".to_string(), true),
                ("|".to_string(), true),
                ("찾음 Warp [Warp.Warp] 버전 v0".to_string(), true),
            ]
        );
    }

    #[test]
    fn progress_frame_is_emitted_as_soon_as_its_carriage_return_arrives() {
        let mut p = TerminalLogProcessor::new();
        let first = p.write("  ███▒▒▒  1.0 MB / 3.0 MB\r");
        assert_eq!(first.len(), 1, "frame must not wait for the next chunk");
        let second = p.write("  ██████  3.0 MB / 3.0 MB\r");
        assert_eq!(second[0].text, "██████  3.0 MB / 3.0 MB");
        assert!(second[0].replace);
    }

    #[test]
    fn coalesces_replace_frames_into_the_last_pending_line() {
        let e = |text: &str, replace: bool| LogEntry { text: text.into(), replace };
        let mut pending = Vec::new();
        coalesce_log_entries(&mut pending, vec![e("start", false), e("10%", false), e("20%", true), e("30%", true)]);
        assert_eq!(pending, vec![e("start", false), e("30%", false)]);
        let mut only_replace = Vec::new();
        coalesce_log_entries(&mut only_replace, vec![e("40%", true), e("50%", true)]);
        assert_eq!(only_replace, vec![e("50%", true)]);
    }

    #[test]
    fn crlf_split_across_chunks_is_append_only() {
        let mut p = TerminalLogProcessor::new();
        let mut entries = p.write("첫 번째 줄\r");
        entries.extend(p.write("\n두 번째 줄\n"));
        entries.extend(p.flush());
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().all(|e| !e.replace));
    }

    #[test]
    fn repairs_double_encoded_utf8() {
        let mojibake = latin1_mojibake("서버에 연결할 수 없습니다.");
        let mut p = TerminalLogProcessor::new();
        let mut entries = p.write(&format!("WinHttpSendRequest: 12029: {mojibake}\n"));
        entries.extend(p.flush());
        assert_eq!(entries[0].text, "WinHttpSendRequest: 12029: 서버에 연결할 수 없습니다.");
        assert_eq!(repair_double_encoded_utf8("Café 1.0 installed"), "Café 1.0 installed");
        let bad = format!("bad {} line", char::from_u32(0x85).unwrap());
        assert_eq!(repair_double_encoded_utf8(&bad), bad);
    }

    fn failed<'a>(stdout: &'a str) -> RunOutput<'a> {
        RunOutput { ok: false, code: Some(1), stdout, stderr: "" }
    }

    #[test]
    fn classifies_failures() {
        assert_eq!(
            classify_failure(&failed(
                "설치 관리자 해시가 일치하지 않습니다. 관리자 권한으로 실행하여 재정의할 수 있습니다."
            )),
            "hash"
        );
        assert_eq!(
            classify_failure(&failed("설치 관리자 해시를 확인했습니다\n설치 관리자가 종료 코드로 인해 실패함: 1618")),
            "installer-busy"
        );
        assert_eq!(
            classify_failure(&failed("설치 관리자 해시를 확인했습니다\n설치 관리자가 종료 코드로 인해 실패함: 1603")),
            "installer"
        );
        assert_eq!(
            classify_failure(&failed("No installed package found matching input criteria.")),
            "not-found"
        );
        assert_eq!(
            classify_failure(&failed("설치 기술이 현재 설치된 버전과 다릅니다.")),
            "install-tech"
        );
        assert_eq!(classify_failure(&failed("something odd")), "generic");
        assert_eq!(classify_failure(&RunOutput { ok: true, code: Some(0), stdout: "", stderr: "" }), "");
    }

    #[test]
    fn summarizes_with_high_signal_lines() {
        let out = "Found Foo [Foo.Foo] Version 1.0\nDownloading https://x\nMsiExec failed: 1603\n";
        assert_eq!(summarize_failure(&failed(out), 3), "MsiExec failed: 1603");
        let empty = RunOutput { ok: false, code: Some(5), stdout: "", stderr: "" };
        assert_eq!(summarize_failure(&empty, 3), "winget exited with code 5");
    }
}
