use crate::models::GameEntry;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

pub struct CacheService {
    cache_path: PathBuf,
    favorites_path: PathBuf,
}

impl CacheService {
    pub fn new(cache_dir: PathBuf) -> Self {
        let cache_path = cache_dir.join("game_cache.json");
        let favorites_path = cache_dir.join("favorites.json");
        CacheService {
            cache_path,
            favorites_path,
        }
    }

    pub fn load(&self) -> Option<Vec<GameEntry>> {
        let content = fs::read_to_string(&self.cache_path).ok()?;
        serde_json::from_str(&content).ok()
    }

    pub fn save(&self, games: &[GameEntry]) -> Result<(), String> {
        let json = serde_json::to_string_pretty(games)
            .map_err(|e| format!("Failed to serialize cache: {}", e))?;
        write_file(&self.cache_path, &json).map_err(|e| format!("Failed to write cache: {}", e))
    }

    pub fn load_favorites(&self) -> HashSet<String> {
        let content = fs::read_to_string(&self.favorites_path).unwrap_or_default();
        serde_json::from_str(&content).unwrap_or_default()
    }

    pub fn save_favorites(&self, favorites: &HashSet<String>) -> Result<(), String> {
        let json = serde_json::to_string_pretty(favorites)
            .map_err(|e| format!("Failed to serialize favorites: {}", e))?;
        write_file(&self.favorites_path, &json)
            .map_err(|e| format!("Failed to write favorites: {}", e))
    }
}

/// Write a file, creating its folder first — `fs::write` alone fails when the
/// data directory doesn't exist yet (e.g. on a fresh install).
fn write_file(path: &Path, contents: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, contents)
}
