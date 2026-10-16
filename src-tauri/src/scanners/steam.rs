use crate::models::{GameEntry, GameSource};
use crate::scanners::PlatformScanner;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use winreg::enums::*;
use winreg::RegKey;

pub struct SteamScanner;

impl PlatformScanner for SteamScanner {
    fn scan(&self) -> Vec<GameEntry> {
        let mut games = Vec::new();
        let mut seen_ids = HashSet::new();

        let steam_path = match get_steam_path() {
            Some(path) => path,
            None => return games,
        };

        let library_folders = get_library_folders(&steam_path);

        for folder in &library_folders {
            let manifest_dir = folder.join("steamapps");
            if !manifest_dir.exists() {
                continue;
            }

            for entry in walkdir::WalkDir::new(&manifest_dir)
                .max_depth(1)
                .into_iter()
                .filter_map(|e| e.ok())
            {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) == Some("acf") {
                    if let Some(game) = parse_app_manifest(path) {
                        if seen_ids.insert(game.id.clone()) {
                            games.push(game);
                        }
                    }
                }
            }
        }

        games
    }
}

fn get_steam_path() -> Option<PathBuf> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let steam = hkcu.open_subkey("Software\\Valve\\Steam").ok()?;
    let path: String = steam.get_value("SteamPath").ok()?;
    Some(PathBuf::from(path.replace('/', "\\")))
}

fn get_library_folders(steam_path: &Path) -> Vec<PathBuf> {
    let mut folders = vec![steam_path.to_path_buf()];

    let vdf_path = steam_path.join("steamapps").join("libraryfolders.vdf");
    if let Ok(content) = fs::read_to_string(&vdf_path) {
        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with("\"path\"") {
                if let Some(path_str) = extract_vdf_string(trimmed) {
                    let path = PathBuf::from(path_str.replace("\\\\", "\\"));
                    if path.exists() && !folders.contains(&path) {
                        folders.push(path);
                    }
                }
            }
        }
    }

    folders
}

fn extract_vdf_string(line: &str) -> Option<String> {
    let parts: Vec<&str> = line.split('"').collect();
    if parts.len() >= 4 {
        Some(parts[3].to_string())
    } else {
        None
    }
}

fn parse_app_manifest(path: &Path) -> Option<GameEntry> {
    let content = fs::read_to_string(path).ok()?;

    let app_id = extract_vdf_value(&content, "appid")?;
    let name = extract_vdf_value(&content, "name")?;
    let install_dir = extract_vdf_value(&content, "installdir")?;

    // The manifest lives in <library>\steamapps, and games live in
    // <library>\steamapps\common\<installdir>. The "steamapps" component is
    // essential — omitting it makes every path (and is_installed) wrong, which
    // hides all Steam games when "Hide games I've removed" is enabled.
    let steamapps_dir = path.parent()?;
    let game_path = steamapps_dir.join("common").join(&install_dir);
    let executable = find_game_executable(&game_path, &name);

    // Construct Steam library cover image URL
    let cover_image_path = format!(
        "https://steamcdn-a.akamaihd.net/steam/apps/{}/header.jpg",
        app_id
    );

    Some(GameEntry {
        id: format!("steam_{}", app_id),
        name,
        description: None,
        install_path: game_path.to_string_lossy().to_string(),
        executable_path: executable.to_string_lossy().to_string(),
        launch_command: format!("steam://rungameid/{}", app_id),
        cover_image_path: Some(cover_image_path),
        source: GameSource::Steam,
        last_played: None,
        total_playtime_seconds: 0,
        is_installed: game_path.exists(),
    })
}

fn extract_vdf_value(content: &str, key: &str) -> Option<String> {
    let pattern = format!("\"{}\"", key);
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with(&pattern) {
            let parts: Vec<&str> = trimmed.split('"').collect();
            if parts.len() >= 4 {
                return Some(parts[3].to_string());
            }
        }
    }
    None
}

fn find_game_executable(game_path: &Path, game_name: &str) -> PathBuf {
    let candidates = vec![
        game_path.join(format!("{}.exe", game_name)),
        game_path.join("game.exe"),
        game_path.join("bin").join(format!("{}.exe", game_name)),
        game_path.join("bin64").join(format!("{}.exe", game_name)),
    ];

    for candidate in &candidates {
        if candidate.exists() {
            return candidate.clone();
        }
    }

    if let Ok(entries) = fs::read_dir(game_path) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("exe") {
                return path;
            }
        }
    }

    game_path.join(format!("{}.exe", game_name))
}
