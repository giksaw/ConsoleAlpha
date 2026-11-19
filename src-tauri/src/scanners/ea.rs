//! EA app (and legacy Origin): titles they install register an uninstall entry
//! whose UninstallString runs EA's own `…\EAInstaller\…\Cleanup.exe`. Inside
//! the game folder, `__Installer\installerdata.xml` names the title and the
//! exe to run. EA games start the EA app themselves when launched from their
//! exe, so that is how we launch them.
//!
//! Publisher alone is not enough: an EA game bought on Steam has an
//! "Electronic Arts" uninstall entry but belongs to Steam.

use super::common::{
    folder_name, guess_executable, icon_exe, id_part, make_entry, read_text, uninstall_entries, xml_text,
};
use crate::models::{GameEntry, GameSource};
use crate::scanners::PlatformScanner;
use std::path::{Path, PathBuf};

pub struct EaScanner;

impl PlatformScanner for EaScanner {
    fn scan(&self) -> Vec<GameEntry> {
        uninstall_entries()
            .into_iter()
            .filter_map(|e| {
                if !is_ea_uninstaller(&e.uninstall_string) || e.install_location.is_empty() {
                    return None;
                }
                let dir = PathBuf::from(&e.install_location);
                if is_steam_path(&dir) {
                    return None;
                }
                let manifest = read_text(&dir.join("__Installer").join("installerdata.xml"))
                    .map(|xml| parse_installer_data(&xml))
                    .unwrap_or_default();

                let name = manifest
                    .title
                    .or_else(|| (!e.display_name.is_empty()).then(|| e.display_name.clone()))
                    .unwrap_or_else(|| folder_name(&dir));
                let exe = manifest
                    .exe_relative
                    .map(|rel| dir.join(rel))
                    .filter(|p| p.is_file())
                    .or_else(|| icon_exe(&e.display_icon))
                    .or_else(|| guess_executable(&dir, &name));
                let id = manifest.content_id.unwrap_or_else(|| e.key.clone());

                Some(make_entry(
                    GameSource::EA,
                    format!("ea_{}", id_part(&id)),
                    name,
                    &dir,
                    exe,
                    None,
                    None,
                ))
            })
            .collect()
    }
}

fn is_ea_uninstaller(uninstall_string: &str) -> bool {
    uninstall_string.to_lowercase().contains("eainstaller")
}

fn is_steam_path(dir: &Path) -> bool {
    dir.to_string_lossy().to_lowercase().contains("\\steamapps\\")
}

#[derive(Debug, Default, PartialEq)]
struct InstallerData {
    title: Option<String>,
    content_id: Option<String>,
    /// Exe path relative to the install folder.
    exe_relative: Option<String>,
}

/// Read the bits we need from `__Installer\installerdata.xml`.
fn parse_installer_data(xml: &str) -> InstallerData {
    // filePath looks like "[HKEY_LOCAL_MACHINE\SOFTWARE\…\Install Dir]Game\x.exe":
    // the bracketed registry reference is the install folder itself.
    let exe_relative = xml_text(xml, "filePath").map(|p| match p.rfind(']') {
        Some(i) => p[i + 1..].trim_start_matches('\\').to_string(),
        None => p,
    });
    InstallerData {
        title: english_title(xml)
            .or_else(|| xml_text(xml, "gameTitle"))
            .map(|t| t.replace(['™', '®'], "").trim().to_string())
            .filter(|t| !t.is_empty()),
        content_id: xml_text(xml, "contentID"),
        exe_relative: exe_relative.filter(|p| !p.is_empty()),
    }
}

/// The `<gameTitle locale="en_US">` entry; the list is often not English-first.
fn english_title(xml: &str) -> Option<String> {
    let marker = "locale=\"en_US\"";
    let at = xml.find(marker)?;
    let body = &xml[at + marker.len()..];
    let start = body.find('>')? + 1;
    let end = body.find("</gameTitle>")?;
    (start <= end).then(|| body[start..end].trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_english_title() {
        let xml = r#"<gameTitles><gameTitle locale="de_DE">Die Sims 4</gameTitle><gameTitle locale="en_US">The Sims 4</gameTitle></gameTitles>"#;
        assert_eq!(parse_installer_data(xml).title.as_deref(), Some("The Sims 4"));
    }

    #[test]
    fn parses_installer_data() {
        let xml = r#"<?xml version="1.0" encoding="utf-8"?>
<DiPManifest version="4.0">
  <runtime>
    <launcher uid="ml-1">
      <filePath>[HKEY_LOCAL_MACHINE\SOFTWARE\EA Games\Mass Effect Legendary Edition\Install Dir]Game\Launcher\MassEffectLauncher.exe</filePath>
      <trial>0</trial>
    </launcher>
  </runtime>
  <contentIDs><contentID>1234567</contentID></contentIDs>
  <gameTitles><gameTitle locale="en_US">Mass Effect™ Legendary Edition</gameTitle></gameTitles>
</DiPManifest>"#;
        assert_eq!(
            parse_installer_data(xml),
            InstallerData {
                title: Some("Mass Effect Legendary Edition".into()),
                content_id: Some("1234567".into()),
                exe_relative: Some(r"Game\Launcher\MassEffectLauncher.exe".into()),
            }
        );
    }

    #[test]
    fn steam_installed_ea_games_are_not_ea() {
        // Real entry on the dev machine: EA publisher, Steam folder, no EA uninstaller.
        assert!(!is_ea_uninstaller(""));
        assert!(is_steam_path(Path::new(
            r"C:\Program Files (x86)\Steam\steamapps\common\ItTakesTwo"
        )));
        assert!(is_ea_uninstaller(
            r#""C:\Program Files\Common Files\EAInstaller\Battlefield 2042\Cleanup.exe" uninstall_game -autologging"#
        ));
    }
}
