//! Ubisoft Connect: `HKLM\SOFTWARE\WOW6432Node\Ubisoft\Launcher\Installs\<id>`
//! holds `InstallDir`; the title comes from the matching "Uplay Install <id>"
//! uninstall entry. Launched with `uplay://launch/<id>/0`.

use super::common::{folder_name, guess_executable, make_entry, uninstall_entries};
use crate::models::{GameEntry, GameSource};
use crate::scanners::PlatformScanner;
use std::path::PathBuf;
use winreg::enums::HKEY_LOCAL_MACHINE;
use winreg::RegKey;

pub struct UbisoftScanner;

impl PlatformScanner for UbisoftScanner {
    fn scan(&self) -> Vec<GameEntry> {
        let Ok(installs) = RegKey::predef(HKEY_LOCAL_MACHINE)
            .open_subkey("SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs")
        else {
            return Vec::new();
        };
        let uninstall = uninstall_entries();

        let mut games = Vec::new();
        for game_id in installs.enum_keys().flatten() {
            let Ok(key) = installs.open_subkey(&game_id) else { continue };
            let Ok(dir) = key.get_value::<String, _>("InstallDir") else { continue };
            let dir = dir.replace('/', "\\");
            let dir = PathBuf::from(dir.trim().trim_end_matches('\\'));
            if dir.as_os_str().is_empty() {
                continue;
            }

            let uninstall_key = format!("Uplay Install {}", game_id);
            let name = uninstall
                .iter()
                .find(|e| e.key.eq_ignore_ascii_case(&uninstall_key))
                .map(|e| e.display_name.clone())
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| folder_name(&dir));

            let exe = guess_executable(&dir, &name);
            games.push(make_entry(
                GameSource::Ubisoft,
                format!("ubisoft_{}", game_id),
                name,
                &dir,
                exe,
                Some(format!("uplay://launch/{}/0", game_id)),
                None,
            ));
        }
        games
    }
}
