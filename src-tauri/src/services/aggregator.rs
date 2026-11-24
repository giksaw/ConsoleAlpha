use crate::models::{GameEntry, ALL_STORES};
use crate::scanners::{
    amazon::AmazonScanner, battlenet::BattleNetScanner, ea::EaScanner, epic::EpicScanner,
    gog::GogScanner, itch::ItchScanner, rockstar::RockstarScanner, steam::SteamScanner,
    ubisoft::UbisoftScanner, xbox::XboxScanner, PlatformScanner,
};
use std::collections::HashSet;

/// Aggregates game lists from all platform scanners
pub struct LibraryAggregator;

impl LibraryAggregator {
    pub fn new() -> Self {
        LibraryAggregator
    }

    /// Scan all supported platforms and return combined results
    pub fn scan_all(&self) -> Vec<GameEntry> {
        let all: Vec<String> = ALL_STORES.iter().map(|s| s.to_string()).collect();
        self.scan_enabled(&all)
    }

    /// Scan only the specified platforms. A game folder reported by two stores
    /// is kept once, from whichever store comes first in `enabled_stores`.
    pub fn scan_enabled(&self, enabled_stores: &[String]) -> Vec<GameEntry> {
        let mut seen_paths = HashSet::new();
        let mut all_games = Vec::new();
        for store in enabled_stores {
            for game in self.scan_platform(store) {
                let key = path_key(&game.install_path);
                if key.is_empty() || seen_paths.insert(key) {
                    all_games.push(game);
                }
            }
        }
        all_games
    }

    /// Scan a single platform by name
    pub fn scan_platform(&self, platform: &str) -> Vec<GameEntry> {
        let scanner: Box<dyn PlatformScanner> = match platform.to_lowercase().as_str() {
            "steam" => Box::new(SteamScanner),
            "epic" => Box::new(EpicScanner),
            "gog" => Box::new(GogScanner),
            "battlenet" => Box::new(BattleNetScanner),
            "ubisoft" => Box::new(UbisoftScanner),
            "ea" => Box::new(EaScanner),
            "xbox" => Box::new(XboxScanner),
            "amazon" => Box::new(AmazonScanner),
            "itch" => Box::new(ItchScanner),
            "rockstar" => Box::new(RockstarScanner),
            _ => return Vec::new(),
        };

        scanner.scan()
    }
}

/// Normalise an install folder for duplicate detection: case-insensitive,
/// one kind of slash, no trailing separator.
pub(crate) fn path_key(path: &str) -> String {
    path.trim()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::path_key;

    #[test]
    fn path_key_ignores_case_and_trailing_slash() {
        assert_eq!(
            path_key("C:/Games/Foo/"),
            path_key("c:\\games\\foo")
        );
        assert_eq!(path_key(""), "");
    }
}
