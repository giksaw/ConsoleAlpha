//! Battle.net: each game has an uninstall entry run by
//! `Blizzard Uninstaller.exe … --uid=<uid>`. The game's own launcher exe (e.g.
//! "Overwatch Launcher.exe") opens Battle.net and starts the game, so that is
//! what we launch — no hard-coded uid → product-code table to go stale.

use super::common::{flag_value, folder_name, guess_executable, icon_exe, id_part, make_entry, uninstall_entries};
use crate::models::{GameEntry, GameSource};
use crate::scanners::PlatformScanner;
use std::fs;
use std::path::{Path, PathBuf};

pub struct BattleNetScanner;

impl PlatformScanner for BattleNetScanner {
    fn scan(&self) -> Vec<GameEntry> {
        uninstall_entries()
            .into_iter()
            .filter_map(|e| {
                let uid = battlenet_uid(&e.uninstall_string)?;
                if e.install_location.is_empty() {
                    return None;
                }
                let dir = PathBuf::from(&e.install_location);
                if !dir.is_dir() {
                    return None; // stale entry — nothing to launch
                }
                let name = if e.display_name.is_empty() { folder_name(&dir) } else { e.display_name.clone() };
                let exe = find_launcher_exe(&dir)
                    .or_else(|| icon_exe(&e.display_icon))
                    .or_else(|| guess_executable(&dir, &name));
                Some(make_entry(
                    GameSource::BattleNet,
                    format!("battlenet_{}", id_part(&uid)),
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

/// The game uid from a Blizzard uninstall string, skipping the client itself.
fn battlenet_uid(uninstall_string: &str) -> Option<String> {
    let lower = uninstall_string.to_lowercase();
    if !lower.contains("blizzard uninstaller") && !lower.contains("battle.net") {
        return None;
    }
    let uid = flag_value(uninstall_string, "--uid")?;
    let client = uid.eq_ignore_ascii_case("battle.net") || uid.eq_ignore_ascii_case("battle_net");
    (!client).then_some(uid)
}

/// "<Game> Launcher.exe" in the install root, which hands off to Battle.net.
fn find_launcher_exe(dir: &Path) -> Option<PathBuf> {
    fs::read_dir(dir).ok()?.flatten().map(|e| e.path()).find(|p| {
        p.is_file()
            && p.file_name()
                .map(|n| n.to_string_lossy().to_lowercase())
                .is_some_and(|n| n.ends_with("launcher.exe"))
    })
}

#[cfg(test)]
mod tests {
    use super::battlenet_uid;

    #[test]
    fn parses_uid_and_skips_client() {
        let game = r#""C:\ProgramData\Battle.net\Agent\Blizzard Uninstaller.exe" --lang=enUS --uid=prometheus --displayname="Overwatch""#;
        assert_eq!(battlenet_uid(game).as_deref(), Some("prometheus"));
        let client = r#""C:\ProgramData\Battle.net\Agent\Blizzard Uninstaller.exe" --lang=enUS --uid=battle.net"#;
        assert_eq!(battlenet_uid(client), None);
        assert_eq!(battlenet_uid(r#""C:\x\unins000.exe" --uid=foo"#), None);
    }
}
