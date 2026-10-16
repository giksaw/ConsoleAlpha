use crate::models::GameEntry;
use crate::services::aggregator::LibraryAggregator;
use crate::services::cache::CacheService;
use crate::services::launcher::GameLauncher;
use tauri::State;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;

pub struct AppState {
    pub cache_dir: PathBuf,
}

#[tauri::command]
pub fn scan_all_games(state: State<'_, Mutex<AppState>>) -> Result<Vec<GameEntry>, String> {
    let aggregator = LibraryAggregator::new();
    let games = aggregator.scan_all();
    let state = state.lock().unwrap();
    let cache = CacheService::new(state.cache_dir.clone());
    let _ = cache.save(&games);
    Ok(games)
}

#[tauri::command]
pub fn get_cached_games(state: State<'_, Mutex<AppState>>) -> Result<Vec<GameEntry>, String> {
    let state = state.lock().unwrap();
    let cache = CacheService::new(state.cache_dir.clone());
    match cache.load() {
        Some(games) => Ok(games),
        None => Ok(Vec::new()),
    }
}

#[tauri::command]
pub fn launch_game(game: GameEntry) -> Result<(), String> {
    let launcher = GameLauncher::new();
    launcher.launch(&game)
}

#[tauri::command]
pub fn rescan_platform(
    platform: String,
    state: State<'_, Mutex<AppState>>,
) -> Result<Vec<GameEntry>, String> {
    let aggregator = LibraryAggregator::new();
    let games = aggregator.scan_platform(&platform);
    let state = state.lock().unwrap();
    let cache = CacheService::new(state.cache_dir.clone());
    let _ = cache.save(&games);
    Ok(games)
}

#[tauri::command]
pub fn toggle_favorite(
    game_id: String,
    state: State<'_, Mutex<AppState>>,
) -> Result<HashSet<String>, String> {
    let state = state.lock().unwrap();
    let cache = CacheService::new(state.cache_dir.clone());
    let mut favorites = cache.load_favorites();
    if favorites.contains(&game_id) {
        favorites.remove(&game_id);
    } else {
        favorites.insert(game_id);
    }
    cache.save_favorites(&favorites)?;
    Ok(favorites)
}

#[tauri::command]
pub fn get_favorites(state: State<'_, Mutex<AppState>>) -> Result<HashSet<String>, String> {
    let state = state.lock().unwrap();
    let cache = CacheService::new(state.cache_dir.clone());
    Ok(cache.load_favorites())
}

#[tauri::command]
pub fn get_game_details(game_id: String, state: State<'_, Mutex<AppState>>) -> Result<Option<GameEntry>, String> {
    let state = state.lock().unwrap();
    let cache = CacheService::new(state.cache_dir.clone());
    let games = cache.load().unwrap_or_default();
    Ok(games.into_iter().find(|g| g.id == game_id))
}
