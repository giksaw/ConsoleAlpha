use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

/// Configuration for which stores are enabled/disabled
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoreConfig {
    /// Map of store name (lowercase) -> enabled status
    pub stores: HashMap<String, bool>,
}

impl Default for StoreConfig {
    fn default() -> Self {
        let mut stores = HashMap::new();
        stores.insert("steam".to_string(), true);
        stores.insert("epic".to_string(), true);
        stores.insert("gog".to_string(), true);
        StoreConfig { stores }
    }
}

impl StoreConfig {
    pub fn new() -> Self {
        Self::default()
    }

    /// Load store config from disk, or return default if not found
    pub fn load(config_path: &PathBuf) -> Self {
        if let Ok(content) = fs::read_to_string(config_path) {
            if let Ok(config) = serde_json::from_str(&content) {
                return config;
            }
        }
        Self::default()
    }

    /// Save store config to disk
    pub fn save(&self, config_path: &PathBuf) -> Result<(), String> {
        if let Some(parent) = config_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create config dir: {}", e))?;
        }
        let json = serde_json::to_string_pretty(self)
            .map_err(|e| format!("Failed to serialize store config: {}", e))?;
        fs::write(config_path, json)
            .map_err(|e| format!("Failed to write store config: {}", e))?;
        Ok(())
    }

    /// Check if a store is enabled
    pub fn is_enabled(&self, store: &str) -> bool {
        *self.stores.get(&store.to_lowercase()).unwrap_or(&true)
    }

    /// Enable or disable a store
    pub fn set_enabled(&mut self, store: &str, enabled: bool) {
        self.stores.insert(store.to_lowercase(), enabled);
    }

    /// Every known store that isn't switched off, in scan order. Stores missing
    /// from the saved file (e.g. added in a newer version) count as enabled.
    pub fn enabled_stores(&self) -> Vec<String> {
        super::ALL_STORES
            .iter()
            .filter(|id| self.is_enabled(id))
            .map(|id| id.to_string())
            .collect()
    }

    /// Get list of disabled store names
    pub fn disabled_stores(&self) -> Vec<String> {
        self.stores
            .iter()
            .filter(|(_, &v)| !v)
            .map(|(k, _)| k.clone())
            .collect()
    }
}
