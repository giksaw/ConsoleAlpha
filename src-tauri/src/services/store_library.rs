//! Owned-but-not-installed games and store-driven installs, for every store
//! that supports them. Each store module does the reading; this one holds the
//! shared types and picks the module.

use crate::services::launcher::shell_open;
use crate::services::{epic_library, steam_library};
use serde::Serialize;

/// A game in the user's store library that isn't installed on this PC.
#[derive(Debug, Clone, Serialize)]
pub struct LibraryGame {
    /// Same id an installed copy gets (`steam_<appid>`, `epic_<AppName>`), so
    /// favorites, hidden state and covers carry over once it's installed.
    pub id: String,
    /// Store id used to install it and to ask for its status
    /// (Steam app id; Epic `namespace:catalogItemId:appName`).
    pub app_id: String,
    /// "steam" | "epic"
    pub store: String,
    pub name: String,
    /// Matches `GameSource` naming ("Steam", "Epic") so the frontend's store
    /// filters and labels work unchanged.
    pub source: String,
    pub cover_image_path: Option<String>,
}

/// How far an install has got.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct InstallStatus {
    pub app_id: String,
    /// "queued" | "preparing" | "downloading" | "verifying" | "installing" |
    /// "paused" | "installed" | "failed" | "none"
    pub state: String,
    /// 0..1 estimate of the download, when known.
    pub progress: Option<f64>,
    pub bytes_total: Option<u64>,
    pub bytes_done: Option<u64>,
    /// Current speed in bytes per second, when known.
    pub rate: Option<f64>,
    /// Why the last attempt stopped, for "failed".
    pub message: Option<String>,
}

impl InstallStatus {
    pub(crate) fn none(app_id: &str) -> Self {
        InstallStatus {
            app_id: app_id.to_string(),
            state: "none".into(),
            progress: None,
            bytes_total: None,
            bytes_done: None,
            rate: None,
            message: None,
        }
    }
}

pub fn owned_uninstalled_games(store: &str) -> Vec<LibraryGame> {
    match store {
        "steam" => steam_library::owned_uninstalled_games(),
        "epic" => epic_library::owned_uninstalled_games(),
        _ => Vec::new(),
    }
}

/// Ask the store client to install a game; it shows its own install dialog.
pub fn install(store: &str, app_id: &str) -> Result<(), String> {
    let uri = match store {
        "steam" => {
            if app_id.is_empty() || !app_id.chars().all(|c| c.is_ascii_digit()) {
                return Err("Invalid app id".to_string());
            }
            format!("steam://install/{}", app_id)
        }
        "epic" => epic_library::install_uri(app_id).ok_or("Invalid app id")?,
        _ => return Err(format!("Installing from {} isn't supported yet", store)),
    };
    shell_open(&uri).map_err(|e| format!("Couldn't open the store app: {}", e))
}

pub fn install_status(store: &str, app_ids: &[String]) -> Vec<InstallStatus> {
    match store {
        "steam" => steam_library::install_status(app_ids),
        "epic" => epic_library::install_status(app_ids),
        _ => app_ids.iter().map(|id| InstallStatus::none(id)).collect(),
    }
}
