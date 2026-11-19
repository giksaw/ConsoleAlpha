use crate::models::{GameEntry, GameSource};
use crate::scanners::PlatformScanner;
use std::fs;
use std::path::PathBuf;
use winreg::enums::*;
use winreg::RegKey;

pub struct GogScanner;

impl PlatformScanner for GogScanner {
    fn scan(&self) -> Vec<GameEntry> {
        let mut games = Vec::new();

        // GOG stores game info in HKLM\SOFTWARE\WOW6432Node\GOG.com\Games
        let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
        let gog_games = match hklm.open_subkey("SOFTWARE\\WOW6432Node\\GOG.com\\Games") {
            Ok(key) => key,
            Err(_) => return games,
        };

        for subkey_name in gog_games.enum_keys().flatten() {
            if let Some(game) = parse_gog_game(&gog_games, &subkey_name) {
                games.push(game);
            }
        }

        games
    }
}

fn parse_gog_game(gog_games: &RegKey, game_key: &str) -> Option<GameEntry> {
    let game = gog_games.open_subkey(game_key).ok()?;

    let game_path: String = game.get_value("path").ok()?;
    let game_name: String = game.get_value("gameName").ok()?;

    let install_path = PathBuf::from(&game_path);

    // GOG records the real executable and its launch parameters; fall back to
    // guessing only when those values are missing or stale.
    let reg_value = |name: &str| {
        game.get_value::<String, _>(name)
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };
    let executable = reg_value("exe")
        .map(PathBuf::from)
        .filter(|p| p.is_file())
        .unwrap_or_else(|| find_gog_executable(&install_path, &game_name));
    let exe_str = executable.to_string_lossy().to_string();
    // The launcher reads arguments as whatever follows the exe in launch_command.
    let launch_command = match reg_value("launchParam") {
        Some(params) => format!("{} {}", exe_str, params),
        None => exe_str.clone(),
    };

    Some(GameEntry {
        id: format!("gog_{}", game_key),
        name: game_name,
        description: None,
        install_path: game_path.clone(),
        executable_path: exe_str,
        launch_command,
        cover_image_path: None,
        source: GameSource::GOG,
        last_played: None,
        total_playtime_seconds: 0,
        is_installed: install_path.exists(),
    })
}

fn find_gog_executable(install_path: &PathBuf, game_name: &str) -> PathBuf {
    // GOG games typically have the exe in the root or a subfolder
    let candidates = vec![
        install_path.join(format!("{}.exe", game_name)),
        install_path.join("game.exe"),
    ];

    for candidate in &candidates {
        if candidate.exists() {
            return candidate.clone();
        }
    }

    // Search for any .exe in root
    if let Ok(entries) = fs::read_dir(install_path) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("exe") {
                return path;
            }
        }
    }

    install_path.join(format!("{}.exe", game_name))
}
