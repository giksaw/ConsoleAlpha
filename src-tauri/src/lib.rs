pub mod models;
pub mod scanners;
pub mod services;
pub mod commands;

use tauri::Manager;
use std::sync::Mutex;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Initialize cache directory
            let cache_dir = app.path().app_data_dir().unwrap();
            std::fs::create_dir_all(&cache_dir)?;
            Ok(())
        })
        .manage(Mutex::new(commands::AppState {
            cache_dir: std::env::temp_dir().join("game-launcher"),
        }))
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
            commands::get_game_size,
            commands::detect_stores,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
