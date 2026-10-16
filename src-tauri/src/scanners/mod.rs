pub mod steam;
pub mod epic;
pub mod gog;

use crate::models::GameEntry;

/// Trait that all platform scanners must implement
pub trait PlatformScanner {
    /// Scan for installed games from this platform
    fn scan(&self) -> Vec<GameEntry>;
}
