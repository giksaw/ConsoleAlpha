mod store_config;
pub use store_config::StoreConfig;

use serde::{Deserialize, Serialize};

/// A candidate cover image returned by a Steam store search.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoverSuggestion {
    pub id: u64,
    pub name: String,
    pub cover: String,
}

/// A store/launcher the app knows how to look for on this machine.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectedStore {
    pub id: String,
    pub name: String,
    pub path: Option<String>,
    pub installed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameEntry {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub install_path: String,
    pub executable_path: String,
    pub launch_command: String,
    pub cover_image_path: Option<String>,
    pub source: GameSource,
    pub last_played: Option<String>,
    pub total_playtime_seconds: u64,
    pub is_installed: bool,
}

/// Where a game came from. The serialized names are what the frontend matches
/// on (`STORE_CATALOG[].source`), so don't rename variants without updating it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum GameSource {
    Steam,
    Epic,
    GOG,
    Xbox,
    BattleNet,
    Ubisoft,
    EA,
    Amazon,
    #[serde(rename = "itch.io")]
    Itch,
    Rockstar,
    Custom,
}

impl GameSource {
    pub fn display_name(&self) -> &'static str {
        match self {
            GameSource::Steam => "Steam",
            GameSource::Epic => "Epic Games",
            GameSource::GOG => "GOG",
            GameSource::Xbox => "Xbox",
            GameSource::BattleNet => "Battle.net",
            GameSource::Ubisoft => "Ubisoft Connect",
            GameSource::EA => "EA App",
            GameSource::Amazon => "Amazon Games",
            GameSource::Itch => "itch.io",
            GameSource::Rockstar => "Rockstar Games",
            GameSource::Custom => "Custom",
        }
    }
}

/// Every store id the scanners understand, in scan order. Earlier stores win
/// when two report the same install folder (e.g. an EA game bought on Steam).
pub const ALL_STORES: &[&str] = &[
    "steam", "epic", "gog", "battlenet", "ubisoft", "ea", "xbox", "amazon", "itch", "rockstar",
];
