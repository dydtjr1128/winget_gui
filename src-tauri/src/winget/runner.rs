//! Process orchestration for winget: trusted path resolution, a serialized
//! runner, truncated-id resolution, and the list/upgrade flows. The only winget
//! module that touches processes or the filesystem.

use super::args::{self, UpgradeOptions};
use super::parser::{self, ExportPackage, LogEntry, RunOutput, TerminalLogProcessor, UpgradeRow};
use super::resolver;
use serde::Serialize;
use serde_json::{json, Value};
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub type Emit = Arc<dyn Fn(&str, Value) + Send + Sync>;

const LOG_FLUSH_INTERVAL: Duration = Duration::from_millis(16);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Package {
    #[serde(flatten)]
    pub row: UpgradeRow,
    pub id_resolution_status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_from_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListResult {
    pub ok: bool,
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub packages: Vec<Package>,
    pub declared_upgrade_count: Option<u32>,
    pub unknown_version_count: u32,
    pub parsed_count: usize,
    pub count_mismatch: bool,
    pub winget_missing: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ItemResult {
    pub id: String,
    pub name: String,
    pub operation: String,
    pub ok: bool,
    pub code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stdout: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stderr: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retried_by_name: Option<bool>,
}

#[derive(Debug, Default)]
pub struct RunResult {
    pub ok: bool,
    pub code: Option<i32>,
    pub not_found: bool,
    pub stdout: String,
    pub stderr: String,
}

impl RunResult {
    fn view(&self) -> RunOutput<'_> {
        RunOutput { ok: self.ok, code: self.code, stdout: &self.stdout, stderr: &self.stderr }
    }
    fn failure_kind(&self) -> String {
        parser::classify_failure(&self.view()).to_string()
    }
    fn failure_detail(&self) -> String {
        parser::summarize_failure(&self.view(), 3)
    }
}

/// Incremental UTF-8 decoder that keeps an incomplete trailing sequence for the
/// next chunk instead of turning it into replacement characters.
#[derive(Default)]
struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut out = String::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(text) => {
                    out.push_str(text);
                    self.pending.clear();
                    return out;
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    out.push_str(std::str::from_utf8(&self.pending[..valid]).unwrap_or_default());
                    match error.error_len() {
                        None => {
                            self.pending.drain(..valid);
                            return out;
                        }
                        Some(len) => {
                            out.push(char::REPLACEMENT_CHARACTER);
                            self.pending.drain(..valid + len);
                        }
                    }
                }
            }
        }
    }

    fn finish(&mut self) -> String {
        let rest = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        rest
    }
}

/// Prefer the admin-only WindowsApps install, then the per-user alias, and only
/// then a bare PATH lookup, so an elevated app never runs a planted winget.exe.
fn resolve_winget_command() -> PathBuf {
    let program_files = std::env::var("ProgramW6432").or_else(|_| std::env::var("ProgramFiles"));
    if let Ok(pf) = program_files {
        let windows_apps = PathBuf::from(pf).join("WindowsApps");
        if let Ok(entries) = std::fs::read_dir(&windows_apps) {
            let mut dirs: Vec<String> = entries
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| n.starts_with("Microsoft.DesktopAppInstaller_") && n.ends_with("__8wekyb3d8bbwe"))
                .collect();
            dirs.sort();
            for dir in dirs.iter().rev() {
                let exe = windows_apps.join(dir).join("winget.exe");
                if exe.exists() {
                    return exe;
                }
            }
        }
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let alias = PathBuf::from(local).join("Microsoft").join("WindowsApps").join("winget.exe");
        if alias.exists() {
            return alias;
        }
    }
    PathBuf::from("winget")
}

fn safe_spawn_cwd() -> PathBuf {
    let root = std::env::var("SystemRoot")
        .or_else(|_| std::env::var("windir"))
        .unwrap_or_else(|_| "C:\\Windows".into());
    PathBuf::from(root).join("System32")
}

pub fn hidden_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

pub struct Runner {
    emit: Emit,
    // Cancellation token of the most recently started operation. Each operation
    // keeps its own token, so starting a new one never clears an earlier cancel.
    active: Mutex<Arc<AtomicBool>>,
    // Serializes winget invocations so cancel always targets the live child.
    lock: Mutex<()>,
    winget: PathBuf,
    // Test seam: replaces process spawning with a fake winget.
    executor: Option<Executor>,
}

pub type Executor = Box<dyn Fn(&[String], &AtomicBool) -> RunResult + Send + Sync>;

impl Runner {
    pub fn new(emit: Emit) -> Self {
        Self {
            emit,
            active: Mutex::new(Arc::new(AtomicBool::new(false))),
            lock: Mutex::new(()),
            winget: resolve_winget_command(),
            executor: None,
        }
    }

    #[cfg(test)]
    pub fn with_executor(emit: Emit, executor: Executor) -> Self {
        Self { executor: Some(executor), ..Self::new(emit) }
    }

    fn log(&self, text: impl Into<String>) {
        (self.emit)("winget:log", json!({ "text": text.into(), "replace": false }));
    }

    /// Sends queued log entries as one batched event.
    fn flush_log(&self, pending: &mut Vec<LogEntry>, last_flush: &mut Instant) {
        if !pending.is_empty() {
            (self.emit)("winget:log", json!(std::mem::take(pending)));
        }
        *last_flush = Instant::now();
    }

    /// Starts an operation with a fresh cancellation token and makes it the one
    /// `cancel()` targets.
    fn begin(&self) -> Arc<AtomicBool> {
        let token = Arc::new(AtomicBool::new(false));
        *self.active.lock().unwrap_or_else(|e| e.into_inner()) = token.clone();
        token
    }

    pub fn cancel(&self) {
        self.active.lock().unwrap_or_else(|e| e.into_inner()).store(true, Ordering::SeqCst);
    }

    pub fn run_winget(&self, token: &AtomicBool, args: &[String], emit_output: bool, force: bool) -> RunResult {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let cancelled = || token.load(Ordering::SeqCst) && !force;
        if cancelled() {
            return RunResult::default();
        }
        if let Some(executor) = &self.executor {
            return executor(args, token);
        }

        let spawned = hidden_command(&self.winget)
            .args(args)
            .current_dir(safe_spawn_cwd())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn();
        let mut child = match spawned {
            Ok(child) => child,
            Err(error) => {
                if emit_output {
                    self.log(error.to_string());
                }
                return RunResult {
                    ok: false,
                    code: Some(-1),
                    not_found: error.kind() == std::io::ErrorKind::NotFound,
                    stderr: error.to_string(),
                    ..Default::default()
                };
            }
        };

        let (tx, rx) = mpsc::channel::<(bool, Vec<u8>)>();
        // Detached readers: they end at EOF or as soon as the receiver is dropped
        // and they try to send again.
        for (is_stdout, pipe) in [
            (true, child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>)),
            (false, child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>)),
        ] {
            if let Some(mut pipe) = pipe {
                let tx = tx.clone();
                std::thread::spawn(move || {
                    let mut buf = [0u8; 8192];
                    while let Ok(n) = pipe.read(&mut buf) {
                        if n == 0 || tx.send((is_stdout, buf[..n].to_vec())).is_err() {
                            break;
                        }
                    }
                });
            }
        }
        drop(tx);

        let mut stdout = String::new();
        let mut stderr = String::new();
        let (mut out_dec, mut err_dec) = (Utf8Stream::default(), Utf8Stream::default());
        let mut processor = TerminalLogProcessor::new();
        let mut exited_at: Option<Instant> = None;
        let mut exit_status: Option<std::process::ExitStatus> = None;
        let mut killed = false;
        // Progress bars can redraw hundreds of times a second; batch log entries
        // into ~one event per display frame so the WebView is not flooded.
        let mut pending: Vec<LogEntry> = Vec::new();
        let mut last_flush = Instant::now();

        loop {
            let received = rx.recv_timeout(LOG_FLUSH_INTERVAL);
            if let Ok((is_stdout, bytes)) = &received {
                let text = if *is_stdout { out_dec.push(bytes) } else { err_dec.push(bytes) };
                if *is_stdout { stdout.push_str(&text) } else { stderr.push_str(&text) }
                if emit_output {
                    parser::coalesce_log_entries(&mut pending, processor.write(&text));
                }
            }
            if last_flush.elapsed() >= LOG_FLUSH_INTERVAL {
                self.flush_log(&mut pending, &mut last_flush);
            }
            let pipes_closed = matches!(received, Err(mpsc::RecvTimeoutError::Disconnected));
            if pipes_closed {
                // Without the timeout the loop would spin once pipes are gone.
                std::thread::sleep(Duration::from_millis(50));
            }
            // Checked on every iteration, and still after the pipes close: winget's
            // progress output can outpace the timeout, and winget can close its
            // pipes before it exits.
            if cancelled() && !killed {
                let _ = child.kill();
                killed = true;
            }
            match child.try_wait() {
                Ok(Some(status)) => {
                    exit_status = Some(status);
                    // An installer launched by winget can inherit the pipes and keep
                    // them open after winget exits; stop waiting shortly after exit.
                    // Readers blocked on such a pipe are detached and end when the
                    // installer closes it.
                    let since = *exited_at.get_or_insert_with(Instant::now);
                    if pipes_closed || since.elapsed() > Duration::from_secs(1) {
                        break;
                    }
                }
                Ok(None) => {}
                Err(_) => break,
            }
        }

        // Keep what the readers already delivered, bounded so a grandchild that
        // keeps writing to an inherited pipe cannot hold us here.
        let drain_deadline = Instant::now() + Duration::from_millis(200);
        while Instant::now() < drain_deadline {
            let Ok((is_stdout, bytes)) = rx.try_recv() else { break };
            let text = if is_stdout { out_dec.push(&bytes) } else { err_dec.push(&bytes) };
            if is_stdout { stdout.push_str(&text) } else { stderr.push_str(&text) }
            if emit_output {
                parser::coalesce_log_entries(&mut pending, processor.write(&text));
            }
        }
        let status = exit_status;
        let tail_out = out_dec.finish();
        let tail_err = err_dec.finish();
        stdout.push_str(&tail_out);
        stderr.push_str(&tail_err);
        if emit_output {
            parser::coalesce_log_entries(&mut pending, processor.write(&tail_out));
            parser::coalesce_log_entries(&mut pending, processor.write(&tail_err));
            parser::coalesce_log_entries(&mut pending, processor.flush());
            self.flush_log(&mut pending, &mut last_flush);
        }
        let code = status.and_then(|s| s.code());
        RunResult { ok: code == Some(0), code, not_found: false, stdout, stderr }
    }

    pub fn list_upgrades(&self, include_unknown: bool, include_pinned: bool) -> ListResult {
        let token = self.begin();
        self.log("winget upgrade 목록을 불러오는 중...");
        let result = self.run_winget(&token, &args::list_args(include_unknown, include_pinned), true, false);
        let parsed = parser::parse_upgrade_result(&result.stdout);

        let packages = self.resolve_truncated_ids(&token, parsed.packages);

        ListResult {
            ok: result.ok,
            code: result.code,
            winget_missing: result.not_found,
            stdout: result.stdout,
            stderr: result.stderr,
            parsed_count: packages.len(),
            packages,
            declared_upgrade_count: parsed.declared_upgrade_count,
            unknown_version_count: parsed.unknown_version_count,
            count_mismatch: parsed.count_mismatch,
        }
    }

    /// `winget export` emits full ids as JSON, the most reliable way to resolve a
    /// truncated table id. Written into a private, freshly created temp directory.
    fn load_export_packages(&self, token: &AtomicBool) -> Vec<ExportPackage> {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        let dir = std::env::temp_dir().join(format!("winget-gui-export-{}-{stamp}", std::process::id()));
        if std::fs::create_dir(&dir).is_err() {
            return Vec::new();
        }
        let path = dir.join("packages.json");
        // export may exit non-zero when some packages are absent from a source,
        // so read the file regardless of the exit code.
        self.run_winget(token, &args::export_args(&path.to_string_lossy()), false, false);
        let packages = std::fs::read(&path)
            .map(|bytes| parser::parse_export_packages(&parser::decode_export_bytes(&bytes)))
            .unwrap_or_default();
        let _ = std::fs::remove_dir_all(&dir);
        packages
    }

    fn resolve_truncated_ids(&self, token: &AtomicBool, rows: Vec<UpgradeRow>) -> Vec<Package> {
        let any_truncated = rows.iter().any(|r| parser::has_truncated_marker(&r.id));
        let export = if any_truncated { self.load_export_packages(token) } else { Vec::new() };

        rows.into_iter()
            .map(|row| {
                if !parser::has_truncated_marker(&row.id) {
                    return Package { row, id_resolution_status: "complete".into(), resolved_from_id: None };
                }
                let prefix = parser::truncated_prefix(&row.id);
                self.log(format!("잘린 패키지 ID 확인 중: {}", row.id));

                // 1) export, 2) installed list (table), 3) catalog search by name.
                let mut resolved = resolver::from_export(&export, &prefix, &row.source, &row.installed_version);
                if resolved.is_none() {
                    let list = self.run_winget(token, &args::list_by_id_args(&prefix, &row.source), false, false);
                    if list.ok {
                        resolved = resolver::from_list_output(
                            &list.stdout,
                            &prefix,
                            &row.source,
                            &row.installed_version,
                            &row.available_version,
                        );
                    }
                }
                if resolved.is_none() {
                    let search = self.run_winget(token, &args::search_args(&prefix, &row.source), false, false);
                    if search.ok {
                        resolved = resolver::from_search_output(&search.stdout, &prefix, &row.source, &row.name);
                    }
                }

                match resolved {
                    Some(id) => {
                        self.log(format!("패키지 ID 보강: {} → {id}", row.id));
                        let original = row.id.clone();
                        Package {
                            row: UpgradeRow { id, ..row },
                            id_resolution_status: "resolved".into(),
                            resolved_from_id: Some(original),
                        }
                    }
                    None => {
                        self.log(format!("패키지 ID 보강 실패: {}", row.id));
                        Package { row, id_resolution_status: "unresolved".into(), resolved_from_id: None }
                    }
                }
            })
            .collect()
    }

    fn read_hash_override(&self, token: &AtomicBool) -> Option<bool> {
        let result = self.run_winget(token, &args::settings_export_args(), false, false);
        if !result.ok {
            return None;
        }
        let bom = char::from_u32(0xfeff).unwrap_or(' ');
        let value: Value = serde_json::from_str(result.stdout.trim_start_matches(bom)).ok()?;
        value.get("adminSettings")?.get("InstallerHashOverride")?.as_bool()
    }

    fn skipped(item: &Package, operation: &str) -> ItemResult {
        ItemResult {
            id: item.row.id.clone(),
            name: item.row.name.clone(),
            operation: operation.into(),
            skipped: Some(true),
            ..Default::default()
        }
    }

    fn truncated_refusal(item: &Package, operation: &str, verb: &str) -> ItemResult {
        ItemResult {
            id: item.row.id.clone(),
            name: item.row.name.clone(),
            operation: operation.into(),
            failure_kind: Some("id-resolution".into()),
            failure_detail: Some(format!(
                "winget 목록에서 패키지 ID가 잘려 안전하게 {verb}할 수 없습니다: {}",
                item.row.id
            )),
            stdout: Some(String::new()),
            stderr: Some(String::new()),
            ..Default::default()
        }
    }

    fn from_run(item: &Package, operation: &str, result: &RunResult) -> ItemResult {
        ItemResult {
            id: item.row.id.clone(),
            name: item.row.name.clone(),
            operation: operation.into(),
            ok: result.ok,
            code: result.code,
            failure_kind: Some(result.failure_kind()),
            failure_detail: Some(result.failure_detail()),
            stdout: Some(result.stdout.clone()),
            stderr: Some(result.stderr.clone()),
            ..Default::default()
        }
    }

    fn start(&self, item: &Package, operation: &str, label: &str) {
        let mut payload = serde_json::to_value(item).unwrap_or_else(|_| json!({}));
        payload["operation"] = json!(operation);
        (self.emit)("winget:package-start", payload);
        let name = if item.row.name.is_empty() { &item.row.id } else { &item.row.name };
        self.log(format!("{label} 시작: {name}"));
    }

    fn complete(&self, results: &mut Vec<ItemResult>, result: ItemResult) {
        (self.emit)("winget:package-complete", json!(result));
        results.push(result);
    }

    pub fn upgrade_selected(&self, packages: &[Package], options: &UpgradeOptions) -> Vec<ItemResult> {
        let token = self.begin();
        let mut results = Vec::new();

        // --ignore-security-hash needs InstallerHashOverride; enable it only when it
        // is confirmed OFF and restore it afterwards.
        let mut enabled_hash_override = false;
        if options.ignore_hash {
            match self.read_hash_override(&token) {
                Some(false) => {
                    enabled_hash_override = self.run_winget(&token, &args::enable_hash_override_args(), false, false).ok;
                    if !enabled_hash_override {
                        self.log("InstallerHashOverride 설정을 켜지 못했습니다(관리자 권한 필요). 해시 검증 무시가 적용되지 않을 수 있습니다.");
                    }
                }
                None => self.log("winget 설정 상태를 확인하지 못해 해시 검증 무시를 안전하게 적용하지 못했습니다."),
                Some(true) => {}
            }
        }

        for item in packages {
            if token.load(Ordering::SeqCst) {
                results.push(Self::skipped(item, "upgrade"));
                continue;
            }
            self.start(item, "upgrade", "업데이트");
            if parser::has_truncated_marker(&item.row.id) {
                self.complete(&mut results, Self::truncated_refusal(item, "upgrade", "업데이트"));
                continue;
            }

            let o = UpgradeOptions { source: item.row.source.clone(), ..options.clone() };
            let mut result = self.run_winget(&token, &args::upgrade_args(&item.row.id, &o), true, false);
            let mut retried = false;
            let name = item.row.name.trim();
            if result.failure_kind() == "not-found"
                && !token.load(Ordering::SeqCst)
                && !name.is_empty()
                && !parser::has_truncated_marker(name)
            {
                self.log(format!("ID로 설치된 패키지를 찾지 못해 이름으로 다시 시도합니다: {name}"));
                result = self.run_winget(&token, &args::upgrade_by_name_args(name, &o), true, false);
                retried = true;
            }
            let mut item_result = Self::from_run(item, "upgrade", &result);
            if retried {
                item_result.retried_by_name = Some(true);
            }
            self.complete(&mut results, item_result);
        }

        if enabled_hash_override {
            let restore = self.run_winget(&token, &args::disable_hash_override_args(), false, true);
            if !restore.ok {
                self.log("InstallerHashOverride 설정을 원래대로 되돌리지 못했습니다. winget settings에서 수동으로 꺼 주세요.");
            }
        }

        (self.emit)("winget:queue-complete", json!(results));
        results
    }

    pub fn uninstall_selected(&self, packages: &[Package], silent: bool) -> Vec<ItemResult> {
        let token = self.begin();
        let mut results = Vec::new();
        for item in packages {
            if token.load(Ordering::SeqCst) {
                results.push(Self::skipped(item, "uninstall"));
                continue;
            }
            self.start(item, "uninstall", "삭제");
            if parser::has_truncated_marker(&item.row.id) {
                self.complete(&mut results, Self::truncated_refusal(item, "uninstall", "삭제"));
                continue;
            }
            let result =
                self.run_winget(&token, &args::uninstall_args(&item.row.id, &item.row.source, silent), true, false);
            self.complete(&mut results, Self::from_run(item, "uninstall", &result));
        }
        (self.emit)("winget:queue-complete", json!(results));
        results
    }

    /// Installs the latest version over the existing copy with `--force`, the
    /// same rescue as `winget install --id <id> -e --source <src> --force`.
    /// Only run on the user's explicit, confirmed request from the UI.
    pub fn force_install_selected(&self, packages: &[Package], silent: bool) -> Vec<ItemResult> {
        let token = self.begin();
        let mut results = Vec::new();
        for item in packages {
            if token.load(Ordering::SeqCst) {
                results.push(Self::skipped(item, "force-install"));
                continue;
            }
            self.start(item, "force-install", "강제 설치");
            if parser::has_truncated_marker(&item.row.id) {
                self.complete(&mut results, Self::truncated_refusal(item, "force-install", "강제 설치"));
                continue;
            }
            let result = self.run_winget(
                &token,
                &args::install_args(&item.row.id, &item.row.source, silent, true),
                true,
                false,
            );
            self.complete(&mut results, Self::from_run(item, "force-install", &result));
        }
        (self.emit)("winget:queue-complete", json!(results));
        results
    }

    /// Uninstall-then-install for packages whose installer technology changed.
    pub fn reinstall_selected(&self, packages: &[Package], silent: bool, force: bool) -> Vec<ItemResult> {
        let token = self.begin();
        let mut results = Vec::new();
        for item in packages {
            if token.load(Ordering::SeqCst) {
                results.push(Self::skipped(item, "reinstall"));
                continue;
            }
            self.start(item, "reinstall", "재설치");
            if parser::has_truncated_marker(&item.row.id) {
                self.complete(&mut results, Self::truncated_refusal(item, "reinstall", "재설치"));
                continue;
            }
            let uninstall =
                self.run_winget(&token, &args::uninstall_args(&item.row.id, &item.row.source, silent), true, false);
            if !uninstall.ok {
                let mut r = Self::from_run(item, "reinstall", &uninstall);
                r.phase = Some("uninstall".into());
                self.complete(&mut results, r);
                continue;
            }
            let install =
                self.run_winget(&token, &args::install_args(&item.row.id, &item.row.source, silent, force), true, false);
            let mut r = Self::from_run(item, "reinstall", &install);
            r.phase = Some("install".into());
            self.complete(&mut results, r);
        }
        (self.emit)("winget:queue-complete", json!(results));
        results
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    type Calls = Arc<Mutex<Vec<String>>>;
    type Events = Arc<Mutex<Vec<(String, Value)>>>;

    fn ok(stdout: &str) -> RunResult {
        RunResult { ok: true, code: Some(0), stdout: stdout.into(), ..Default::default() }
    }

    fn fail(stdout: &str) -> RunResult {
        RunResult { ok: false, code: Some(1), stdout: stdout.into(), ..Default::default() }
    }

    /// Builds a runner whose fake winget records every call and answers via `respond`.
    fn fake(
        respond: impl Fn(&str, &AtomicBool) -> RunResult + Send + Sync + 'static,
    ) -> (Runner, Calls, Events) {
        let calls: Calls = Arc::default();
        let events: Events = Arc::default();
        let recorded = calls.clone();
        let sink = events.clone();
        let emit: Emit = Arc::new(move |channel: &str, payload: Value| {
            sink.lock().unwrap().push((channel.to_string(), payload));
        });
        let executor: Executor = Box::new(move |args: &[String], cancelled: &AtomicBool| {
            let line = args.join(" ");
            recorded.lock().unwrap().push(line.clone());
            respond(&line, cancelled)
        });
        (Runner::with_executor(emit, executor), calls, events)
    }

    fn pkg(id: &str, name: &str, source: &str) -> Package {
        Package {
            row: UpgradeRow {
                name: name.into(),
                id: id.into(),
                installed_version: "1.0".into(),
                available_version: "2.0".into(),
                source: source.into(),
            },
            id_resolution_status: "complete".into(),
            resolved_from_id: None,
        }
    }

    const NOT_FOUND: &str = "No installed package found matching input criteria.";

    #[test]
    fn reports_winget_missing_when_spawn_fails() {
        let (runner, _, _) = fake(|_, _| RunResult { code: Some(-1), not_found: true, ..Default::default() });
        let result = runner.list_upgrades(false, false);
        assert!(result.winget_missing);
        assert!(result.packages.is_empty());
    }

    #[test]
    fn cancel_skips_the_rest_of_the_queue() {
        let (runner, calls, _) = fake(|_, cancelled| {
            cancelled.store(true, Ordering::SeqCst);
            fail("")
        });
        let results = runner.upgrade_selected(&[pkg("Alpha.Alpha", "Alpha", ""), pkg("Beta.Beta", "Beta", "")], &UpgradeOptions::default());
        assert_eq!(calls.lock().unwrap().len(), 1);
        assert_eq!(results.len(), 2);
        assert_eq!(results[1].skipped, Some(true));
    }

    #[test]
    fn a_new_operation_does_not_clear_an_earlier_cancel() {
        let runner = Arc::new(fake(|_, _| ok("")).0);
        let first = runner.begin();
        runner.cancel();
        // A refresh starts while the cancelled queue is still unwinding.
        runner.list_upgrades(false, false);
        assert!(first.load(Ordering::SeqCst));
        assert!(runner.run_winget(&first, &args::list_args(false, false), false, false).code.is_none());
    }

    #[test]
    fn cancel_targets_the_latest_operation() {
        let (runner, calls, _) = fake(|_, _| ok(""));
        runner.cancel();
        let results = runner.uninstall_selected(&[pkg("Foo.Bar", "Foo", "")], false);
        assert!(results[0].ok, "a cancel before the queue started must not skip it");
        assert_eq!(calls.lock().unwrap().len(), 1);
    }

    #[test]
    fn upgrade_pins_each_package_to_its_source() {
        let (runner, calls, _) = fake(|_, _| ok(""));
        runner.upgrade_selected(&[pkg("A.A", "A", "winget"), pkg("B.B", "B", "msstore"), pkg("C.C", "C", "")], &UpgradeOptions::default());
        let calls = calls.lock().unwrap();
        assert!(calls[0].ends_with("--source winget"));
        assert!(calls[1].ends_with("--source msstore"));
        assert!(!calls[2].contains("--source"));
    }

    #[test]
    fn upgrade_retries_by_exact_name_after_not_found() {
        let (runner, calls, _) = fake(|line, _| if line.contains("--id") { fail(NOT_FOUND) } else { ok("") });
        let results = runner.upgrade_selected(&[pkg("Microsoft.PowerShell", "PowerShell 7", "winget")], &UpgradeOptions::default());
        let calls = calls.lock().unwrap();
        assert_eq!(calls.len(), 2);
        assert!(calls[1].starts_with("upgrade --name PowerShell 7 --exact"));
        assert!(results[0].ok);
        assert_eq!(results[0].retried_by_name, Some(true));
    }

    #[test]
    fn upgrade_never_escalates_to_install_on_its_own() {
        // Even with --force on, a not-found upgrade stays a failure; the forced
        // install is a separate action the user must confirm.
        let (runner, calls, _) = fake(|_, _| fail(NOT_FOUND));
        let o = UpgradeOptions { force: true, ..Default::default() };
        let results = runner.upgrade_selected(&[pkg("Microsoft.PowerShell", "PowerShell 7", "winget")], &o);
        let calls = calls.lock().unwrap();
        assert!(calls.iter().all(|c| c.starts_with("upgrade") && c.ends_with("--force")), "{calls:?}");
        assert_eq!(results[0].failure_kind.as_deref(), Some("not-found"));
    }

    #[test]
    fn force_install_runs_the_manual_rescue_command() {
        let (runner, calls, events) = fake(|_, _| ok("설치 성공"));
        let results = runner.force_install_selected(&[pkg("Microsoft.PowerShell", "PowerShell 7", "winget")], true);
        assert_eq!(
            calls.lock().unwrap().as_slice(),
            ["install --id Microsoft.PowerShell --exact --accept-package-agreements --accept-source-agreements --disable-interactivity --source winget --silent --force"]
        );
        assert!(results[0].ok);
        assert_eq!(results[0].operation, "force-install");
        let events = events.lock().unwrap();
        let start = events.iter().find(|(c, _)| c == "winget:package-start").unwrap();
        assert_eq!(start.1["operation"], "force-install");
    }

    #[test]
    fn force_install_refuses_truncated_ids() {
        let (runner, calls, _) = fake(|_, _| ok(""));
        let results = runner.force_install_selected(&[pkg("Microsoft.PowerSh…", "PowerShell", "winget")], false);
        assert!(calls.lock().unwrap().is_empty());
        assert_eq!(results[0].failure_kind.as_deref(), Some("id-resolution"));
    }

    #[test]
    fn reinstall_passes_force_to_the_install_step_only() {
        let (runner, calls, _) = fake(|_, _| ok(""));
        runner.reinstall_selected(&[pkg("Foo.Bar", "Foo", "winget")], false, true);
        let calls = calls.lock().unwrap();
        assert!(!calls[0].contains("--force"));
        assert!(calls[1].starts_with("install") && calls[1].ends_with("--force"));
    }

    #[test]
    fn name_retry_keeps_not_found_when_it_also_fails() {
        let (runner, _, _) = fake(|_, _| fail(NOT_FOUND));
        let results = runner.upgrade_selected(&[pkg("A.B", "Some App", "")], &UpgradeOptions::default());
        assert!(!results[0].ok);
        assert_eq!(results[0].failure_kind.as_deref(), Some("not-found"));
    }

    #[test]
    fn no_name_retry_for_missing_or_truncated_names_or_other_failures() {
        for name in ["", "Visual Studio Co…"] {
            let (runner, calls, _) = fake(|_, _| fail(NOT_FOUND));
            runner.upgrade_selected(&[pkg("A.B", name, "")], &UpgradeOptions::default());
            assert_eq!(calls.lock().unwrap().len(), 1, "name {name:?}");
        }
        let (runner, calls, _) = fake(|_, _| fail("설치 관리자가 종료 코드로 인해 실패함: 1603"));
        runner.upgrade_selected(&[pkg("A.B", "App", "")], &UpgradeOptions::default());
        assert_eq!(calls.lock().unwrap().len(), 1);
    }

    #[test]
    fn uninstall_runs_exact_id_and_emits_operation_events() {
        let (runner, calls, events) = fake(|_, _| ok(""));
        let results = runner.uninstall_selected(&[pkg("Foo.Bar", "Foo", "winget")], true);
        assert_eq!(
            calls.lock().unwrap()[0],
            "uninstall --id Foo.Bar --exact --accept-source-agreements --disable-interactivity --source winget --silent"
        );
        assert!(results[0].ok);
        let events = events.lock().unwrap();
        let start = events.iter().find(|(c, _)| c == "winget:package-start").unwrap();
        assert_eq!(start.1["operation"], "uninstall");
        assert_eq!(start.1["id"], "Foo.Bar");
        assert!(events.iter().any(|(c, _)| c == "winget:queue-complete"));
    }

    #[test]
    fn truncated_ids_are_never_spawned() {
        let (runner, calls, _) = fake(|_, _| ok(""));
        let truncated = [pkg("TheDocumentFoundation.Libr…", "LibreOffice", "winget")];
        let upgrade = runner.upgrade_selected(&truncated, &UpgradeOptions::default());
        let uninstall = runner.uninstall_selected(&truncated, false);
        let reinstall = runner.reinstall_selected(&truncated, false, false);
        assert!(calls.lock().unwrap().is_empty());
        for r in [&upgrade[0], &uninstall[0], &reinstall[0]] {
            assert_eq!(r.failure_kind.as_deref(), Some("id-resolution"));
        }
    }

    #[test]
    fn reinstall_uninstalls_then_installs_from_same_source() {
        let (runner, calls, _) = fake(|_, _| ok(""));
        let results = runner.reinstall_selected(&[pkg("Foo.Bar", "Foo", "winget")], false, false);
        let calls = calls.lock().unwrap();
        assert!(calls[0].starts_with("uninstall --id Foo.Bar"));
        assert!(calls[1].starts_with("install --id Foo.Bar") && calls[1].contains("--source winget"));
        assert_eq!(results[0].phase.as_deref(), Some("install"));
    }

    #[test]
    fn reinstall_skips_install_when_uninstall_fails() {
        let (runner, calls, _) = fake(|_, _| fail("Error 1730 must be an Administrator"));
        let results = runner.reinstall_selected(&[pkg("Foo.Bar", "Foo", "")], false, false);
        assert_eq!(calls.lock().unwrap().len(), 1);
        assert_eq!(results[0].phase.as_deref(), Some("uninstall"));
        assert_eq!(results[0].failure_kind.as_deref(), Some("requires-admin"));
    }

    fn hash_calls(export: &'static str) -> Vec<String> {
        let (runner, calls, _) = fake(move |line, _| if line == "settings export" { ok(export) } else { ok("") });
        let o = UpgradeOptions { ignore_hash: true, ..Default::default() };
        runner.upgrade_selected(&[pkg("Foo.Bar", "Foo", "")], &o);
        let calls = calls.lock().unwrap().clone();
        calls
    }

    #[test]
    fn ignore_hash_enables_then_restores_the_setting() {
        let calls = hash_calls(r#"{"adminSettings":{"InstallerHashOverride":false}}"#);
        assert!(calls.contains(&"settings --enable InstallerHashOverride".to_string()));
        assert!(calls.iter().any(|c| c.starts_with("upgrade") && c.contains("--ignore-security-hash")));
        assert_eq!(calls.last().unwrap(), "settings --disable InstallerHashOverride");
    }

    #[test]
    fn ignore_hash_leaves_setting_alone_when_enabled_or_unknown() {
        for export in [r#"{"adminSettings":{"InstallerHashOverride":true}}"#, "not json at all"] {
            let calls = hash_calls(export);
            assert!(!calls.iter().any(|c| c.starts_with("settings --")), "{export}");
        }
    }

    #[test]
    fn list_resolves_truncated_ids_via_list_fallback() {
        let table = "
Name                        Id                          Version  Available Source
-----------------------------------------------------------------------------------
LibreOffice 26.2.2.2        TheDocumentFoundation.Libr… 26.2.2.2 26.2.3.2  winget
1 upgrades available.
";
        let installed = "
Name                 Id                                Version  Available Source
---------------------------------------------------------------------------------
LibreOffice 26.2.2.2 TheDocumentFoundation.LibreOffice 26.2.2.2 26.2.3.2  winget
";
        let (runner, calls, _) = fake(move |line, _| {
            if line.starts_with("upgrade") {
                ok(table)
            } else if line.starts_with("list --id") {
                ok(installed)
            } else {
                fail("")
            }
        });
        let result = runner.list_upgrades(false, false);
        assert_eq!(result.packages[0].row.id, "TheDocumentFoundation.LibreOffice");
        assert_eq!(result.packages[0].id_resolution_status, "resolved");
        assert_eq!(result.packages[0].resolved_from_id.as_deref(), Some("TheDocumentFoundation.Libr…"));
        assert!(calls.lock().unwrap().iter().any(|c| c.starts_with("export --output")));
    }

    #[test]
    fn utf8_stream_keeps_split_multibyte_sequences() {
        let bytes = "한글".as_bytes();
        let mut dec = Utf8Stream::default();
        let mut out = dec.push(&bytes[..2]);
        out.push_str(&dec.push(&bytes[2..4]));
        out.push_str(&dec.push(&bytes[4..]));
        out.push_str(&dec.finish());
        assert_eq!(out, "한글");
    }
}
