//! Rockstar Games Launcher: titles register an uninstall entry run by
//! `…\Rockstar Games\Launcher\uninstall.exe -uninstall=<title id>`. The game's
//! own exe (e.g. PlayGTAV.exe) starts the Rockstar launcher when needed.

use super::common::{flag_value, folder_name, guess_executable, icon_exe, id_part, make_entry, uninstall_entries};
use crate::models::{GameEntry, GameSource};
use crate::scanners::PlatformScanner;
use std::path::PathBuf;

pub struct RockstarScanner;

impl PlatformScanner for RockstarScanner {
    fn scan(&self) -> Vec<GameEntry> {
        uninstall_entries()
            .into_iter()
            .filter_map(|e| {
                let title_id = rockstar_title_id(&e.uninstall_string, &e.display_name)?;
                if e.install_location.is_empty() {
                    return None;
                }
                let dir = PathBuf::from(&e.install_location);
                let name = if e.display_name.is_empty() { folder_name(&dir) } else { e.display_name.clone() };
                let exe = icon_exe(&e.display_icon)
                    .filter(|p| p.starts_with(&dir))
                    .or_else(|| guess_executable(&dir, &name));
                Some(make_entry(
                    GameSource::Rockstar,
                    format!("rockstar_{}", id_part(&title_id)),
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

/// The title id from a Rockstar uninstall string; None for the launcher and
/// Social Club themselves, which are not games.
fn rockstar_title_id(uninstall_string: &str, display_name: &str) -> Option<String> {
    let lower = uninstall_string.to_lowercase();
    if !lower.contains("rockstar games\\launcher") {
        return None;
    }
    let name = display_name.to_lowercase();
    if name.contains("launcher") || name.contains("social club") {
        return None;
    }
    flag_value(uninstall_string, "-uninstall")
}

#[cfg(test)]
mod tests {
    use super::rockstar_title_id;

    #[test]
    fn parses_title_and_skips_launcher() {
        let gta = r#""C:\Program Files\Rockstar Games\Launcher\uninstall.exe" -uninstall=gta5"#;
        assert_eq!(rockstar_title_id(gta, "Grand Theft Auto V").as_deref(), Some("gta5"));
        let launcher = r#""C:\Program Files\Rockstar Games\Launcher\uninstall.exe" -uninstall=launcher"#;
        assert_eq!(rockstar_title_id(launcher, "Rockstar Games Launcher"), None);
        assert_eq!(rockstar_title_id(r#""C:\x\unins000.exe" -uninstall=foo"#, "Foo"), None);
    }
}
