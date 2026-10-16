use crate::models::GameEntry;
use crate::scanners::{epic::EpicScanner, gog::GogScanner, steam::SteamScanner, PlatformScanner};

/// Aggregates game lists from all platform scanners
pub struct LibraryAggregator;

impl LibraryAggregator {
    pub fn new() -> Self {
        LibraryAggregator
    }

    /// Scan all supported platforms and return combined results
    pub fn scan_all(&self) -> Vec<GameEntry> {
        let scanners: Vec<Box<dyn PlatformScanner>> = vec![
            Box::new(SteamScanner),
            Box::new(EpicScanner),
            Box::new(GogScanner),
        ];

        let mut all_games = Vec::new();
        for scanner in scanners {
            let games = scanner.scan();
            all_games.extend(games);
        }

        all_games
    }

    /// Scan only the specified platforms
    pub fn scan_enabled(&self, enabled_stores: &[String]) -> Vec<GameEntry> {
        let mut all_games = Vec::new();
        for store in enabled_stores {
            let games = self.scan_platform(store);
            all_games.extend(games);
        }
        all_games
    }

    /// Scan a single platform by name
    pub fn scan_platform(&self, platform: &str) -> Vec<GameEntry> {
        let scanner: Box<dyn PlatformScanner> = match platform.to_lowercase().as_str() {
            "steam" => Box::new(SteamScanner),
            "epic" => Box::new(EpicScanner),
            "gog" => Box::new(GogScanner),
            _ => return Vec::new(),
        };

        scanner.scan()
    }
}
