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
            commands::open_game_folder,
            commands::search_steam_covers,
            commands::search_steamgriddb_covers,
            commands::get_game_size,
            commands::detect_stores,
            tray::set_keep_in_tray,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
