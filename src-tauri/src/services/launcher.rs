use crate::models::GameEntry;
use std::path::{Path, PathBuf};
use std::process::Command;

pub struct GameLauncher;

impl GameLauncher {
    pub fn new() -> Self {
        GameLauncher
    }

    /// Launch a game entry.
    ///
    /// Store titles carry a protocol link (`steam://…`, `com.epicgames.launcher://…`)
    /// so the store client starts them with its own login, overlay and DRM.
    /// Everything else runs its executable directly, with any launch arguments.
    pub fn launch(&self, game: &GameEntry) -> Result<(), String> {
        if is_protocol_uri(&game.launch_command) {
            return shell_open(&game.launch_command)
                .map_err(|e| format!("Failed to launch {}: {}", game.name, e));
        }
        // Packaged (Xbox / Microsoft Store) games: `shell:AppsFolder\<PFN>!<AppId>`.
        // Their exe can't be run directly, and rundll32 doesn't resolve shell:
        // paths, so hand it to Explorer.
        if game.launch_command.starts_with("shell:AppsFolder\\") {
            return Command::new("explorer")
                .arg(&game.launch_command)
                .spawn()
                .map(|_| ())
                .map_err(|e| format!("Failed to launch {}: {}", game.name, e));
        }

        let exe = Path::new(&game.executable_path);
        if !exe.is_file() {
            return Err(format!("Executable not found: {}", game.executable_path));
        }

        let mut cmd = Command::new(exe);
        let args = launch_args(game);
        if !args.is_empty() {
            append_args(&mut cmd, args);
        }
        if let Some(dir) = working_dir(game) {
            cmd.current_dir(dir);
        }

        cmd.spawn()
            .map(|_| ())
            .map_err(|e| format!("Failed to launch game: {}", e))
    }
}

/// True for `scheme://…` links. Windows paths (`C:\…`) never contain `://`.
fn is_protocol_uri(s: &str) -> bool {
    match s.split_once("://") {
        Some((scheme, _)) => {
            !scheme.is_empty()
                && scheme
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '.' || c == '-')
        }
        None => false,
    }
}

/// Launch arguments are whatever follows the executable in `launch_command`.
/// Custom games and GOG titles store `"<exe> <args>"`, so no extra field is needed
/// and games saved by older versions keep working.
fn launch_args(game: &GameEntry) -> &str {
    game.launch_command
        .strip_prefix(game.executable_path.as_str())
        .map(str::trim)
        .unwrap_or("")
}

#[cfg(target_os = "windows")]
fn append_args(cmd: &mut Command, args: &str) {
    // Pass the user's argument string through verbatim so their own quoting
    // (e.g. `-config "C:\My Games\a.ini"`) survives.
    use std::os::windows::process::CommandExt;
    cmd.raw_arg(args);
}

#[cfg(not(target_os = "windows"))]
fn append_args(cmd: &mut Command, args: &str) {
    cmd.args(args.split_whitespace());
}

/// Run from the install folder when it exists, else from the executable's folder.
fn working_dir(game: &GameEntry) -> Option<PathBuf> {
    let install = Path::new(&game.install_path);
    if !game.install_path.trim().is_empty() && install.is_dir() {
        return Some(install.to_path_buf());
    }
    Path::new(&game.executable_path)
        .parent()
        .filter(|p| p.is_dir())
        .map(Path::to_path_buf)
}

/// Hand a URL or protocol link to the OS so the registered handler opens it.
///
/// Deliberately avoids `cmd /C start`: cmd treats `&` as a command separator,
/// which cut query strings short (Google searches, Epic `?action=launch&silent=true`).
pub fn shell_open(target: &str) -> Result<(), String> {
    // Links are passed as a single unquoted argument, so encode stray spaces.
    let target = target.trim().replace(' ', "%20");

    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = Command::new("rundll32");
        c.arg("url.dll,FileProtocolHandler").arg(&target);
        c
    };

    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = Command::new("open");
        c.arg(&target);
        c
    };

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let mut cmd = {
        let mut c = Command::new("xdg-open");
        c.arg(&target);
        c
    };

    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}
