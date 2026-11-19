pub mod amazon;
pub mod battlenet;
mod common;
pub mod ea;
pub mod epic;
pub mod gog;
pub mod itch;
pub mod rockstar;
pub mod steam;
pub mod ubisoft;
pub mod xbox;

use crate::models::GameEntry;

/// Trait that all platform scanners must implement
pub trait PlatformScanner {
    /// Scan for installed games from this platform
    fn scan(&self) -> Vec<GameEntry>;
}
