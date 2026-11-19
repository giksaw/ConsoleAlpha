//! Xbox app (PC Game Pass / Microsoft Store GDK games): installed under
//! `<drive>:\XboxGames\<Game>\Content\MicrosoftGame.config` by default. A
//! drive's `.GamingRoot` file can point at a different folder name.
//!
//! These are packaged apps — their exe can't be started directly — so they are
//! launched through `shell:AppsFolder\<PackageFamilyName>!<AppId>`, with the
//! family name looked up from the per-user AppModel package repository.

use super::common::{folder_name, make_entry, read_text, xml_attr};
use crate::models::{GameEntry, GameSource};
use crate::scanners::PlatformScanner;
use std::fs;
use std::path::PathBuf;
use winreg::enums::HKEY_CURRENT_USER;
use winreg::RegKey;

pub struct XboxScanner;

impl PlatformScanner for XboxScanner {
    fn scan(&self) -> Vec<GameEntry> {
        let roots = game_roots();
        if roots.is_empty() {
            return Vec::new();
        }
        let packages = installed_package_names();

        let mut games = Vec::new();
        for root in roots {
            let Ok(entries) = fs::read_dir(&root) else { continue };
            for entry in entries.flatten() {
                let dir = entry.path();
                let config_path = dir.join("Content").join("MicrosoftGame.config");
                let Some(xml) = read_text(&config_path) else { continue };
                let Some(config) = parse_game_config(&xml) else { continue };

                let name = config
                    .display_name
                    .clone()
                    .filter(|n| !n.starts_with("ms-resource:"))
                    .unwrap_or_else(|| folder_name(&dir));
                let exe = config
                    .exe
                    .as_ref()
                    .map(|e| dir.join("Content").join(e))
                    .filter(|p| p.is_file());
                let launch = package_family_name(&packages, &config.identity)
                    .map(|pfn| format!("shell:AppsFolder\\{}!{}", pfn, config.app_id));

                games.push(make_entry(
                    GameSource::Xbox,
                    format!("xbox_{}", config.identity.to_lowercase()),
                    name,
                    &dir,
                    exe,
                    launch,
                    None,
                ));
            }
        }
        games
    }
}

#[derive(Debug, PartialEq)]
struct GameConfig {
    identity: String,
    display_name: Option<String>,
    exe: Option<String>,
    app_id: String,
}

fn parse_game_config(xml: &str) -> Option<GameConfig> {
    Some(GameConfig {
        identity: xml_attr(xml, "Identity", "Name")?,
        display_name: xml_attr(xml, "ShellVisuals", "DefaultDisplayName"),
        exe: xml_attr(xml, "Executable", "Name"),
        app_id: xml_attr(xml, "Executable", "Id").unwrap_or_else(|| "Game".to_string()),
    })
}

/// `X:\XboxGames` (or the folder named in `X:\.GamingRoot`) on every drive.
fn game_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for letter in b'C'..=b'Z' {
        let drive = PathBuf::from(format!("{}:\\", letter as char));
        if !drive.exists() {
            continue;
        }
        let folder = fs::read(drive.join(".GamingRoot"))
            .ok()
            .and_then(|b| parse_gaming_root(&b))
            .unwrap_or_else(|| "XboxGames".to_string());
        let root = drive.join(folder.trim_start_matches('\\'));
        if root.is_dir() && !roots.contains(&root) {
            roots.push(root);
        }
    }
    roots
}

/// `.GamingRoot` is "RGBX", a 4-byte count, then a UTF-16LE NUL-terminated path.
fn parse_gaming_root(bytes: &[u8]) -> Option<String> {
    if bytes.len() < 10 || &bytes[..4] != b"RGBX" {
        return None;
    }
    let units: Vec<u16> = bytes[8..]
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .take_while(|&u| u != 0)
        .collect();
    let s = String::from_utf16(&units).ok()?;
    (!s.trim().is_empty()).then(|| s.trim().to_string())
}

/// Full names (`Name_Version_Arch_ResourceId_PublisherId`) of the user's packages.
fn installed_package_names() -> Vec<String> {
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(
            "Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages",
        )
        .map(|k| k.enum_keys().flatten().collect())
        .unwrap_or_default()
}

/// `Name_PublisherId` for the package whose identity is `name`.
fn package_family_name(packages: &[String], name: &str) -> Option<String> {
    let prefix = format!("{}_", name.to_lowercase());
    packages
        .iter()
        .find(|full| full.to_lowercase().starts_with(&prefix))
        .and_then(|full| full.rsplit('_').next())
        .map(|publisher_id| format!("{}_{}", name, publisher_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_config() {
        let xml = r#"<?xml version="1.0" encoding="utf-8"?>
<Game configVersion="1">
  <Identity Name="Microsoft.624F8B84B80" Publisher="CN=A, O=B" Version="3.1.0.0"/>
  <ExecutableList>
    <Executable Name="ForzaHorizon5.exe" Id="Game" TargetDeviceFamily="PC"/>
  </ExecutableList>
  <ShellVisuals DefaultDisplayName="Forza Horizon 5" PublisherDisplayName="Xbox Game Studios"/>
</Game>"#;
        assert_eq!(
            parse_game_config(xml),
            Some(GameConfig {
                identity: "Microsoft.624F8B84B80".into(),
                display_name: Some("Forza Horizon 5".into()),
                exe: Some("ForzaHorizon5.exe".into()),
                app_id: "Game".into(),
            })
        );
    }

    #[test]
    fn family_name_from_full_name() {
        let pkgs = vec![
            "Microsoft.WindowsStore_22401.1400.6.0_x64__8wekyb3d8bbwe".to_string(),
            "Microsoft.624F8B84B80_3.1.0.0_x64__8wekyb3d8bbwe".to_string(),
        ];
        assert_eq!(
            package_family_name(&pkgs, "Microsoft.624F8B84B80").as_deref(),
            Some("Microsoft.624F8B84B80_8wekyb3d8bbwe")
        );
        assert_eq!(package_family_name(&pkgs, "Missing.Game"), None);
    }

    #[test]
    fn gaming_root_file() {
        let mut bytes = b"RGBX\x01\x00\x00\x00".to_vec();
        for u in "\\MyGames".encode_utf16().chain([0u16]) {
            bytes.extend_from_slice(&u.to_le_bytes());
        }
        assert_eq!(parse_gaming_root(&bytes).as_deref(), Some("\\MyGames"));
        assert_eq!(parse_gaming_root(b"nope"), None);
    }
}
