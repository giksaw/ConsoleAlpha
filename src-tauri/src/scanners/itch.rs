//! itch.io app: games installed to the default location
//! (`%APPDATA%\itch\apps\<game>`) carry a gzipped receipt at
//! `.itch\receipt.json.gz` with the game's id, title and cover. A
//! `.itch.toml` manifest, when the developer ships one, names the exe.
//! Extra install locations configured in the itch app are not covered.

use super::common::{folder_name, guess_executable, make_entry};
use crate::models::{GameEntry, GameSource};
use crate::scanners::PlatformScanner;
use flate2::read::GzDecoder;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

pub struct ItchScanner;

impl PlatformScanner for ItchScanner {
    fn scan(&self) -> Vec<GameEntry> {
        let Ok(appdata) = std::env::var("APPDATA") else {
            return Vec::new();
        };
        let apps = PathBuf::from(appdata).join("itch").join("apps");
        let Ok(entries) = fs::read_dir(&apps) else {
            return Vec::new();
        };

        let mut games = Vec::new();
        for entry in entries.flatten() {
            let dir = entry.path();
            let Some(receipt) = read_receipt(&dir.join(".itch").join("receipt.json.gz")) else {
                continue;
            };
            let Some(info) = parse_receipt(&receipt) else { continue };

            let name = info.title.unwrap_or_else(|| folder_name(&dir));
            let exe = manifest_exe(&dir).or_else(|| guess_executable(&dir, &name));
            games.push(make_entry(
                GameSource::Itch,
                format!("itch_{}", info.id),
                name,
                &dir,
                exe,
                None,
                info.cover,
            ));
        }
        games
    }
}

fn read_receipt(path: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let mut out = String::new();
    GzDecoder::new(file).read_to_string(&mut out).ok()?;
    Some(out)
}

#[derive(Debug, PartialEq)]
struct ReceiptInfo {
    id: u64,
    title: Option<String>,
    cover: Option<String>,
}

fn parse_receipt(json: &str) -> Option<ReceiptInfo> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    let game = v.get("game")?;
    let text = |key: &str| {
        game.get(key)
            .and_then(|s| s.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    Some(ReceiptInfo {
        id: game.get("id")?.as_u64()?,
        title: text("title"),
        // Prefer the still image: coverUrl may be an animated GIF.
        cover: text("stillCoverUrl").or_else(|| text("coverUrl")),
    })
}

/// First `path = "…"` of an `[[actions]]` entry in `.itch.toml`, if it's an exe.
fn manifest_exe(dir: &Path) -> Option<PathBuf> {
    let toml = fs::read_to_string(dir.join(".itch.toml")).ok()?;
    let rel = parse_manifest_path(&toml)?;
    let path = dir.join(rel.replace('/', "\\"));
    let is_exe = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("exe"));
    (is_exe && path.is_file()).then_some(path)
}

fn parse_manifest_path(toml: &str) -> Option<String> {
    toml.lines().find_map(|line| {
        let (key, value) = line.split_once('=')?;
        if key.trim() != "path" {
            return None;
        }
        let v = value.trim().trim_matches(|c| c == '"' || c == '\'');
        (!v.is_empty()).then(|| v.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_receipt() {
        let json = r#"{"game":{"id":12345,"title":"A Short Hike","coverUrl":"https://img.itch.zone/a.gif","stillCoverUrl":"https://img.itch.zone/a.png"},"upload":{"id":1}}"#;
        assert_eq!(
            parse_receipt(json),
            Some(ReceiptInfo {
                id: 12345,
                title: Some("A Short Hike".into()),
                cover: Some("https://img.itch.zone/a.png".into()),
            })
        );
        assert_eq!(parse_receipt(r#"{"upload":{}}"#), None);
    }

    #[test]
    fn parses_manifest_path() {
        let toml = "[[actions]]\nname = \"play\"\npath = \"bin/Game.exe\"\n";
        assert_eq!(parse_manifest_path(toml).as_deref(), Some("bin/Game.exe"));
    }
}
