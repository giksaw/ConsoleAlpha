pub mod models;
pub mod scanners;
pub mod services;
pub mod commands;
mod tray;

use tauri::Manager;
use std::sync::Mutex;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Library cache, favorites and store config live in the per-user app
            // data dir (%APPDATA%\com.giksaw.gameconsolealpha). It used to be %TEMP%,
            // which was never created and is routinely cleaned out.
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            app.manage(Mutex::new(commands::AppState { cache_dir: data_dir }));
            tray::setup(app)?;
            Ok(())
        })
        .manage(tray::KeepInTray::default())
        .on_window_event(tray::on_window_event)
        .invoke_handler(tauri::generate_handler![
            commands::scan_all_games,
            commands::launch_game,
            commands::get_cached_games,
            commands::rescan_platform,
            commands::toggle_favorite,
            commands::get_favorites,
            commands::get_game_details,
            commands::get_store_config,
            commands::set_store_config,
            commands::open_url,
            commands::get_store_library,
            commands::install_store_game,
            commands::store_install_status,
            commands::open_game_folder,
            commands::search_steam_covers,
            commands::search_steamgriddb_covers,
            commands::get_trending_games,
            commands::search_store_games,
            commands::get_game_size,
            commands::detect_stores,
            commands::game_folders::get_game_folders,
            commands::game_folders::add_game_folder,
            commands::game_folders::remove_game_folder,
            commands::game_folders::set_game_folders_periodic,
            commands::game_folders::mark_game_folders,
            commands::game_folders::reset_ignored_folders,
            commands::game_folders::check_game_folders,
            commands::game_folders::pick_folder,
            commands::game_folders::pick_executable,
            tray::set_keep_in_tray,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
