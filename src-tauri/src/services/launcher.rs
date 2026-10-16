use crate::models::GameEntry;
use std::process::Command;

pub struct GameLauncher;

impl GameLauncher {
    pub fn new() -> Self {
        GameLauncher
    }

    /// Launch a game entry
    pub fn launch(&self, game: &GameEntry) -> Result<(), String> {
        if game.source == crate::models::GameSource::Steam {
            // Use steam:// URI protocol
            Command::new("cmd")
                .args(["/C", "start", &game.launch_command])
                .spawn()
                .map_err(|e| format!("Failed to launch via Steam: {}", e))?;
        } else {
            // Launch executable directly
            Command::new(&game.executable_path)
                .current_dir(&game.install_path)
                .spawn()
                .map_err(|e| format!("Failed to launch game: {}", e))?;
        }

        Ok(())
    }
}
