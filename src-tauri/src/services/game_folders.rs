//! Game folders: folders the user keeps games in (e.g. `D:\Games`). Each
//! subfolder that isn't in the library yet is offered as a new game, once.
//!
//! Saved as `game_folders.json` in the app data dir. Every subfolder the user
//! has answered for is remembered in `seen`, so a folder is never offered twice.

use crate::scanners::common::{clean_title, list_executables};
use crate::services::aggregator::path_key;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// How many executables to offer per folder.
const MAX_EXES: usize = 10;

/// What the user decided about a subfolder.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SeenStatus {
    Added,
    Ignored,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct GameFolders {
    /// Folders to watch, as the user picked them.
    pub folders: Vec<String>,
    /// Also check every 30 minutes while the app runs (not only on launch).
    pub check_periodically: bool,
    /// Subfolder (by `path_key`) → what the user decided.
    pub seen: BTreeMap<String, SeenStatus>,
}

impl Default for GameFolders {
    fn default() -> Self {
        GameFolders { folders: Vec::new(), check_periodically: true, seen: BTreeMap::new() }
    }
}

/// A game folder as the settings page shows it.
#[derive(Debug, Clone, Serialize)]
pub struct FolderInfo {
    pub path: String,
    pub exists: bool,
    /// Subfolders the user chose to ignore.
    pub ignored: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct GameFoldersView {
    pub folders: Vec<FolderInfo>,
    pub check_periodically: bool,
}

/// A subfolder that looks like a game not yet in the library.
#[derive(Debug, Clone, Serialize)]
pub struct FolderCandidate {
    /// The subfolder itself, e.g. `D:\Games\Hades`.
    pub folder: String,
    /// The game folder it was found in, e.g. `D:\Games`.
    pub parent: String,
    /// Suggested title, cleaned up from the folder name.
    pub title: String,
    /// Full paths of likely game executables, best guess first.
    pub exes: Vec<String>,
}

/// Subfolders that hold other launchers' libraries, not one game.
const LAUNCHER_DIRS: &[&str] = &[
    "steamlibrary", "steamapps", "steam", "epic games", "gog games", "gog galaxy",
    "ubisoft game launcher", "ea games", "origin games", "xboxgames", "windowsapps",
    "amazon games", "battle.net", "rockstar games", "itch", "$recycle.bin",
    "system volume information",
];

impl GameFolders {
    pub fn load(path: &Path) -> Self {
        fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        let json = serde_json::to_string_pretty(self)
            .map_err(|e| format!("Failed to serialize game folders: {}", e))?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(path, json).map_err(|e| format!("Failed to save game folders: {}", e))
    }

    /// Add a folder unless it's already listed. Errors if it isn't a folder.
    pub fn add_folder(&mut self, folder: &str) -> Result<(), String> {
        let folder = folder.trim();
        if !Path::new(folder).is_dir() {
            return Err("That folder doesn't exist".into());
        }
        let key = path_key(folder);
        if !self.folders.iter().any(|f| path_key(f) == key) {
            self.folders.push(folder.trim_end_matches(['\\', '/']).to_string());
        }
        Ok(())
    }

    pub fn remove_folder(&mut self, folder: &str) {
        let key = path_key(folder);
        self.folders.retain(|f| path_key(f) != key);
    }

    pub fn mark(&mut self, folders: &[String], status: SeenStatus) {
        for f in folders {
            self.seen.insert(path_key(f), status);
        }
    }

    /// Forget which subfolders of `folder` were ignored, so they're offered again.
    pub fn reset_ignored(&mut self, folder: &str) {
        let prefix = format!("{}\\", path_key(folder));
        self.seen
            .retain(|k, v| !(*v == SeenStatus::Ignored && k.starts_with(&prefix)));
    }

    pub fn view(&self) -> GameFoldersView {
        let folders = self
            .folders
            .iter()
            .map(|f| {
                let prefix = format!("{}\\", path_key(f));
                FolderInfo {
                    path: f.clone(),
                    exists: Path::new(f).is_dir(),
                    ignored: self
                        .seen
                        .iter()
                        .filter(|(k, v)| **v == SeenStatus::Ignored && k.starts_with(&prefix))
                        .count(),
                }
            })
            .collect();
        GameFoldersView { folders, check_periodically: self.check_periodically }
    }

    /// Subfolders of the game folders that look like games not yet in the library.
    ///
    /// `known` holds paths already in the library (install folders, executables).
    /// Subfolders with no executable yet, or changed in the last `settle` (still
    /// copying or unzipping), are skipped without being marked seen, so a later
    /// check picks them up.
    pub fn candidates(&self, known: &[String], settle: Duration) -> Vec<FolderCandidate> {
        let known: HashSet<String> = known
            .iter()
            .map(|k| path_key(k))
            .filter(|k| !k.is_empty())
            .collect();
        // A game folder nested in another is not itself a game.
        let watched: HashSet<String> = self.folders.iter().map(|f| path_key(f)).collect();
        let mut out = Vec::new();
        let mut offered = HashSet::new();
        for parent in &self.folders {
            let Ok(entries) = fs::read_dir(parent) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                let key = path_key(&path.to_string_lossy());
                if self.seen.contains_key(&key)
                    || watched.contains(&key)
                    || !offered.insert(key.clone())
                    || !path.is_dir()
                    || is_hidden_or_launcher_dir(&path)
                    || overlaps_library(&key, &known)
                    || is_store_install(&path)
                    || changed_within(&path, settle)
                {
                    continue;
                }
                let exes = list_executables(&path, MAX_EXES);
                if exes.is_empty() || exes.iter().any(|e| changed_within(e, settle)) {
                    continue;
                }
                let name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();
                out.push(FolderCandidate {
                    folder: path.to_string_lossy().to_string(),
                    parent: parent.clone(),
                    title: clean_title(&name),
                    exes: exes.iter().map(|e| e.to_string_lossy().to_string()).collect(),
                });
            }
        }
        out.sort_by_key(|c| c.title.to_lowercase());
        out
    }
}

/// True if a library path is this folder or inside it. (Not the other way round:
/// a custom game whose exe sits loose in `D:\Games` must not hide every
/// subfolder of `D:\Games`.)
fn overlaps_library(key: &str, known: &HashSet<String>) -> bool {
    let inside = format!("{}\\", key);
    known.iter().any(|k| k == key || k.starts_with(&inside))
}

/// A game a store manages: Epic leaves an `.egstore` folder, GOG a
/// `goggame-<id>.info` file. The store scan picks these up, so offering them
/// too would list the game twice — e.g. when a store installs into a game
/// folder while the app runs and the 30-minute check sees it before a rescan.
fn is_store_install(dir: &Path) -> bool {
    if dir.join(".egstore").is_dir() {
        return true;
    }
    fs::read_dir(dir).is_ok_and(|entries| {
        entries.flatten().any(|e| {
            let name = e.file_name().to_string_lossy().to_lowercase();
            name.starts_with("goggame-") && name.ends_with(".info")
        })
    })
}

fn is_hidden_or_launcher_dir(path: &Path) -> bool {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if name.starts_with('.') || name.starts_with('$') || LAUNCHER_DIRS.contains(&name.as_str()) {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const HIDDEN: u32 = 0x2;
        const SYSTEM: u32 = 0x4;
        if let Ok(meta) = fs::metadata(path) {
            return meta.file_attributes() & (HIDDEN | SYSTEM) != 0;
        }
    }
    false
}

/// Created or modified less than `window` ago.
fn changed_within(path: &Path, window: Duration) -> bool {
    if window.is_zero() {
        return false;
    }
    let Ok(meta) = fs::metadata(path) else {
        return false;
    };
    let now = SystemTime::now();
    [meta.created().ok(), meta.modified().ok()]
        .into_iter()
        .flatten()
        .any(|t| now.duration_since(t).map(|age| age < window).unwrap_or(true))
}

/// `game_folders.json` in the app data dir.
pub fn config_path(data_dir: &Path) -> PathBuf {
    data_dir.join("game_folders.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("gca-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn make_game(root: &Path, folder: &str, exe: &str) {
        let dir = root.join(folder);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(exe), vec![0u8; 64]).unwrap();
    }

    #[test]
    fn finds_new_games_and_skips_known_seen_and_empty() {
        let root = temp_root("folders");
        make_game(&root, "Hades_v1.38", "Hades.exe");
        make_game(&root, "Celeste", "Celeste.exe");
        make_game(&root, "Ignored Game", "game.exe");
        make_game(&root, "Steam Game", "game.exe");
        make_game(&root, "Custom Game", "game.exe");
        make_game(&root, "SteamLibrary", "steam.exe");
        make_game(&root, "Epic Game", "game.exe");
        fs::create_dir_all(root.join("Epic Game").join(".egstore")).unwrap();
        make_game(&root, "GOG Game", "game.exe");
        fs::write(root.join("GOG Game").join("goggame-1207658924.info"), b"{}").unwrap();
        fs::create_dir_all(root.join("Saves")).unwrap(); // no exe yet

        let mut cfg = GameFolders::default();
        cfg.add_folder(&root.to_string_lossy()).unwrap();
        // Adding the same folder again (other case / trailing slash) is a no-op.
        cfg.add_folder(&format!("{}\\", root.to_string_lossy().to_uppercase())).unwrap();
        assert_eq!(cfg.folders.len(), 1);
        cfg.mark(&[root.join("Ignored Game").to_string_lossy().to_string()], SeenStatus::Ignored);

        let known = vec![
            // A store game installed in the folder.
            root.join("Steam Game").to_string_lossy().to_string(),
            // A custom game whose exe lives inside the folder.
            root.join("custom game").join("game.exe").to_string_lossy().to_string(),
        ];
        let found = cfg.candidates(&known, Duration::ZERO);
        let titles: Vec<_> = found.iter().map(|c| c.title.as_str()).collect();
        assert_eq!(titles, vec!["Celeste", "Hades"]);
        assert_eq!(found[1].exes, vec![root.join("Hades_v1.38").join("Hades.exe").to_string_lossy().to_string()]);
        assert_eq!(found[1].parent, cfg.folders[0]);

        // Freshly created folders are left for a later check.
        assert!(cfg.candidates(&known, Duration::from_secs(3600)).is_empty());

        // Answered folders are not offered again; reset brings ignored ones back.
        cfg.mark(&[found[0].folder.clone()], SeenStatus::Added);
        assert_eq!(cfg.candidates(&known, Duration::ZERO).len(), 1);
        assert_eq!(cfg.view().folders[0].ignored, 1);
        cfg.reset_ignored(&root.to_string_lossy());
        assert_eq!(cfg.view().folders[0].ignored, 0);
        let titles: Vec<_> = cfg.candidates(&known, Duration::ZERO).into_iter().map(|c| c.title).collect();
        assert_eq!(titles, vec!["Hades", "Ignored Game"]);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn add_folder_rejects_missing_and_save_round_trips() {
        let root = temp_root("folders-save");
        let mut cfg = GameFolders::default();
        assert!(cfg.add_folder(&root.join("missing").to_string_lossy()).is_err());
        cfg.add_folder(&root.to_string_lossy()).unwrap();
        cfg.check_periodically = false;
        let file = config_path(&root);
        cfg.save(&file).unwrap();
        let loaded = GameFolders::load(&file);
        assert_eq!(loaded.folders, cfg.folders);
        assert!(!loaded.check_periodically);
        // A missing file gives the defaults.
        assert!(GameFolders::load(&root.join("nope.json")).check_periodically);
        cfg.remove_folder(&root.to_string_lossy().to_uppercase());
        assert!(cfg.folders.is_empty());
        let _ = fs::remove_dir_all(&root);
    }
}
