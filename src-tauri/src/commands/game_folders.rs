//! Commands for game folders (see `services::game_folders`) and the native
//! file/folder pickers.

use super::{data_dir, AppState};
use crate::services::cache::CacheService;
use crate::services::game_folders::{
    config_path, FolderCandidate, GameFolders, GameFoldersView, SeenStatus,
};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

/// Subfolders changed more recently than this may still be copying or unzipping.
const SETTLE: Duration = Duration::from_secs(60);

/// Load, change and save the game-folder config. The state lock is held the
/// whole time so two commands can't drop each other's changes.
fn update(
    state: &State<'_, Mutex<AppState>>,
    change: impl FnOnce(&mut GameFolders) -> Result<(), String>,
) -> Result<GameFoldersView, String> {
    let guard = state.lock().map_err(|_| "App state is unavailable".to_string())?;
    let path = config_path(&guard.cache_dir);
    let mut cfg = GameFolders::load(&path);
    change(&mut cfg)?;
    cfg.save(&path)?;
    Ok(cfg.view())
}

#[tauri::command]
pub fn get_game_folders(state: State<'_, Mutex<AppState>>) -> Result<GameFoldersView, String> {
    let dir = data_dir(&state)?;
    Ok(GameFolders::load(&config_path(&dir)).view())
}

#[tauri::command]
pub fn add_game_folder(
    path: String,
    state: State<'_, Mutex<AppState>>,
) -> Result<GameFoldersView, String> {
    update(&state, |cfg| cfg.add_folder(&path))
}

#[tauri::command]
pub fn remove_game_folder(
    path: String,
    state: State<'_, Mutex<AppState>>,
) -> Result<GameFoldersView, String> {
    update(&state, |cfg| {
        cfg.remove_folder(&path);
        Ok(())
    })
}

#[tauri::command]
pub fn set_game_folders_periodic(
    enabled: bool,
    state: State<'_, Mutex<AppState>>,
) -> Result<GameFoldersView, String> {
    update(&state, |cfg| {
        cfg.check_periodically = enabled;
        Ok(())
    })
}

/// Remember the user's answer for these subfolders so they aren't offered again.
#[tauri::command]
pub fn mark_game_folders(
    folders: Vec<String>,
    status: SeenStatus,
    state: State<'_, Mutex<AppState>>,
) -> Result<GameFoldersView, String> {
    update(&state, |cfg| {
        cfg.mark(&folders, status);
        Ok(())
    })
}

#[tauri::command]
pub fn reset_ignored_folders(
    path: String,
    state: State<'_, Mutex<AppState>>,
) -> Result<GameFoldersView, String> {
    update(&state, |cfg| {
        cfg.reset_ignored(&path);
        Ok(())
    })
}

/// New games in the game folders. `known_paths` are the custom games' paths
/// (they live in the frontend); store games come from the saved library.
#[tauri::command]
pub async fn check_game_folders(
    known_paths: Vec<String>,
    state: State<'_, Mutex<AppState>>,
) -> Result<Vec<FolderCandidate>, String> {
    let dir = data_dir(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let cfg = GameFolders::load(&config_path(&dir));
        if cfg.folders.is_empty() {
            return Vec::new();
        }
        let mut known = known_paths;
        for game in CacheService::new(dir).load().unwrap_or_default() {
            known.push(game.install_path);
            known.push(game.executable_path);
        }
        cfg.candidates(&known, SETTLE)
    })
    .await
    .map_err(|e| format!("Folder check failed: {}", e))
}

/// Native folder picker. `None` when the user cancels.
#[tauri::command]
pub async fn pick_folder(app: AppHandle, title: Option<String>) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app.dialog().file();
        if let Some(title) = title {
            dialog = dialog.set_title(title);
        }
        if let Some(window) = app.get_webview_window("main") {
            dialog = dialog.set_parent(&window);
        }
        dialog
            .blocking_pick_folder()
            .and_then(|p| p.into_path().ok())
            .map(|p| p.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())
}

/// Native picker for a program (.exe). `None` when the user cancels.
#[tauri::command]
pub async fn pick_executable(app: AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app
            .dialog()
            .file()
            .set_title("Choose the game's executable")
            .add_filter("Programs", &["exe"]);
        if let Some(window) = app.get_webview_window("main") {
            dialog = dialog.set_parent(&window);
        }
        dialog
            .blocking_pick_file()
            .and_then(|p| p.into_path().ok())
            .map(|p| p.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())
}
