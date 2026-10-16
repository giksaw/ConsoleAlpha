use crate::models::{GameEntry, GameSource};
use crate::scanners::PlatformScanner;
use std::fs;
use std::path::{Path, PathBuf};

pub struct EpicScanner;

impl PlatformScanner for EpicScanner {
    fn scan(&self) -> Vec<GameEntry> {
        let mut games = Vec::new();

        let manifest_dir = PathBuf::from(
            std::env::var("ProgramData")
                .unwrap_or_else(|_| "C:\\ProgramData".to_string()),
        )
        .join("Epic")
        .join("EpicGamesLauncher")
        .join("Data")
        .join("Manifests");

        if !manifest_dir.exists() {
            return games;
        }

        for entry in walkdir::WalkDir::new(&manifest_dir)
            .max_depth(1)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("item") {
                if let Some(game) = parse_manifest(path) {
                    games.push(game);
                }
            }
        }

        games
    }
}

fn parse_manifest(path: &Path) -> Option<GameEntry> {
    let content = fs::read_to_string(path).ok()?;
    let manifest: serde_json::Value = serde_json::from_str(&content).ok()?;

    let display_name = manifest.get("DisplayName")?.as_str()?.to_string();
    let install_location = manifest.get("InstallLocation")?.as_str()?.to_string();
    let app_name = manifest.get("AppName")?.as_str()?.to_string();
    let launch_exe = manifest.get("LaunchExecutable")?.as_str()?.to_string();

    let install_path = PathBuf::from(&install_location);
    let executable_path = install_path.join(&launch_exe);

    // Some Epic titles ship a cover thumbnail in the manifest; use it when present.
    let cover_image_path = manifest
        .get("VaultThumbnailUrl")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string());

    Some(GameEntry {
        id: format!("epic_{}", app_name),
        name: display_name,
        description: None,
        install_path: install_location,
        executable_path: executable_path.to_string_lossy().to_string(),
        launch_command: executable_path.to_string_lossy().to_string(),
        cover_image_path,
        source: GameSource::Epic,
        last_played: None,
        total_playtime_seconds: 0,
        is_installed: install_path.exists(),
    })
}
