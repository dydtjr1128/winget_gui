mod winget;

use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use winget::args::UpgradeOptions;
use winget::runner::{hidden_command, ItemResult, ListResult, Package, Runner};

struct AppState {
    runner: Arc<Runner>,
    // Only ids returned by the last list can be acted on, so the renderer can
    // never make the elevated backend run winget on an arbitrary id.
    known: Arc<Mutex<HashMap<String, Package>>>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Options {
    silent: bool,
    include_unknown: bool,
    include_pinned: bool,
    ignore_hash: bool,
}

fn select_known(state: &AppState, ids: &[String]) -> Vec<Package> {
    let known = state.known.lock().unwrap_or_else(|e| e.into_inner());
    ids.iter().filter_map(|id| known.get(id).cloned()).collect()
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_upgrades(state: State<'_, AppState>, options: Option<Options>) -> Result<ListResult, String> {
    let o = options.unwrap_or_default();
    let runner = state.runner.clone();
    let result = blocking(move || runner.list_upgrades(o.include_unknown, o.include_pinned)).await?;
    let mut known = state.known.lock().unwrap_or_else(|e| e.into_inner());
    *known = result.packages.iter().map(|p| (p.row.id.clone(), p.clone())).collect();
    Ok(result)
}

#[tauri::command]
async fn upgrade_selected(
    state: State<'_, AppState>,
    ids: Vec<String>,
    options: Option<Options>,
) -> Result<Vec<ItemResult>, String> {
    let packages = select_known(&state, &ids);
    if packages.is_empty() {
        return Ok(Vec::new());
    }
    let o = options.unwrap_or_default();
    let upgrade = UpgradeOptions {
        source: String::new(),
        silent: o.silent,
        include_unknown: o.include_unknown,
        include_pinned: o.include_pinned,
        ignore_hash: o.ignore_hash,
    };
    let runner = state.runner.clone();
    blocking(move || runner.upgrade_selected(&packages, &upgrade)).await
}

#[tauri::command]
async fn uninstall_selected(
    state: State<'_, AppState>,
    ids: Vec<String>,
    options: Option<Options>,
) -> Result<Vec<ItemResult>, String> {
    let packages = select_known(&state, &ids);
    if packages.is_empty() {
        return Ok(Vec::new());
    }
    let silent = options.unwrap_or_default().silent;
    let runner = state.runner.clone();
    let results = blocking(move || runner.uninstall_selected(&packages, silent)).await?;
    let mut known = state.known.lock().unwrap_or_else(|e| e.into_inner());
    for r in results.iter().filter(|r| r.ok) {
        known.remove(&r.id);
    }
    Ok(results)
}

#[tauri::command]
async fn reinstall_selected(
    state: State<'_, AppState>,
    ids: Vec<String>,
    options: Option<Options>,
) -> Result<Vec<ItemResult>, String> {
    let packages = select_known(&state, &ids);
    if packages.is_empty() {
        return Ok(Vec::new());
    }
    let silent = options.unwrap_or_default().silent;
    let runner = state.runner.clone();
    blocking(move || runner.reinstall_selected(&packages, silent)).await
}

#[tauri::command]
fn cancel_upgrade(state: State<'_, AppState>) -> bool {
    state.runner.cancel();
    true
}

/// Reads TokenElevation from this process's token: no child process, no delay.
#[cfg(windows)]
fn running_elevated() -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    // SAFETY: the token handle is opened for this process only, checked before
    // use and closed once; TOKEN_ELEVATION is a plain u32 struct whose exact
    // size is passed to GetTokenInformation.
    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return false;
        }
        let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
        let mut returned = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            (&mut elevation as *mut TOKEN_ELEVATION).cast(),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut returned,
        );
        CloseHandle(token);
        ok != 0 && elevation.TokenIsElevated != 0
    }
}

#[cfg(not(windows))]
fn running_elevated() -> bool {
    false
}

#[tauri::command]
async fn is_elevated() -> Result<bool, String> {
    blocking(running_elevated).await
}

/// A Tauri exe is a single file that is not unpacked to a shared directory, so
/// it can launch the elevated copy directly and quit once UAC was accepted.
#[tauri::command]
async fn restart_elevated(app: AppHandle) -> Result<Value, String> {
    if blocking(running_elevated).await? {
        return Ok(json!({ "ok": true, "alreadyElevated": true }));
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    // The path goes through an environment variable, never into the script
    // text, so quotes (including PowerShell's smart quotes) cannot break out.
    let status = blocking(move || {
        hidden_command("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command"])
            .arg("Start-Process -FilePath $env:WINGET_GUI_RELAUNCH_EXE -Verb RunAs")
            .env("WINGET_GUI_RELAUNCH_EXE", exe)
            .status()
    })
    .await?
    .map_err(|e| e.to_string())?;

    if status.success() {
        app.exit(0);
        Ok(json!({ "ok": true }))
    } else {
        Ok(json!({ "ok": false, "message": "Administrator elevation was cancelled or failed." }))
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Restores and saves window size, position and maximized state.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            let handle = app.handle().clone();
            let emit: winget::runner::Emit = Arc::new(move |channel: &str, payload: Value| {
                let _ = handle.emit(channel, payload);
            });
            app.manage(AppState {
                runner: Arc::new(Runner::new(emit)),
                known: Arc::new(Mutex::new(HashMap::new())),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_upgrades,
            upgrade_selected,
            uninstall_selected,
            reinstall_selected,
            cancel_upgrade,
            is_elevated,
            restart_elevated
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn token_elevation_matches_net_session() {
        // `net session` succeeds only for an elevated administrator.
        let net_session = hidden_command("net")
            .arg("session")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        assert_eq!(running_elevated(), net_session);
    }
}
