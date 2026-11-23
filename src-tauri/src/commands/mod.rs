use crate::models::{CoverSuggestion, DetectedStore, GameEntry, StoreConfig};
use crate::services::aggregator::LibraryAggregator;
use crate::services::cache::CacheService;
use crate::services::launcher::{shell_open, GameLauncher};
use tauri::State;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;

pub struct AppState {
    /// Where the game cache, favorites and store config live (the app data dir).
    pub cache_dir: PathBuf,
}

/// Copy the data directory out of the shared state, releasing the lock at once.
fn data_dir(state: &State<'_, Mutex<AppState>>) -> Result<PathBuf, String> {
    state
        .lock()
        .map(|s| s.cache_dir.clone())
        .map_err(|_| "App state is unavailable".to_string())
}

/// Scan every enabled store. Runs on the blocking pool: a sync command would run
/// on the main thread and freeze the window for the whole scan.
#[tauri::command]
pub async fn scan_all_games(state: State<'_, Mutex<AppState>>) -> Result<Vec<GameEntry>, String> {
    let dir = data_dir(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let store_config = StoreConfig::load(&dir.join("store_config.json"));
        let games = LibraryAggregator::new().scan_enabled(&store_config.enabled_stores());
        if let Err(e) = CacheService::new(dir).save(&games) {
            eprintln!("[cache] {}", e);
        }
        games
    })
    .await
    .map_err(|e| format!("Scan failed: {}", e))
}

#[tauri::command]
pub fn get_cached_games(state: State<'_, Mutex<AppState>>) -> Result<Vec<GameEntry>, String> {
    let state = state.lock().unwrap();
    let cache = CacheService::new(state.cache_dir.clone());
    match cache.load() {
        Some(games) => Ok(games),
        None => Ok(Vec::new()),
    }
}

#[tauri::command]
pub fn launch_game(game: GameEntry) -> Result<(), String> {
    let launcher = GameLauncher::new();
    launcher.launch(&game)
}

/// Rescan one store and merge it into the cached library. Returns the full
/// library, so other stores' games are kept rather than overwritten.
#[tauri::command]
pub async fn rescan_platform(
    platform: String,
    state: State<'_, Mutex<AppState>>,
) -> Result<Vec<GameEntry>, String> {
    let dir = data_dir(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let fresh = LibraryAggregator::new().scan_platform(&platform);
        // Scanner ids are "<store>_<id>" (steam_, epic_, gog_).
        let prefix = format!("{}_", platform.to_lowercase());
        let cache = CacheService::new(dir);
        let mut games: Vec<GameEntry> = cache
            .load()
            .unwrap_or_default()
            .into_iter()
            .filter(|g| !g.id.starts_with(&prefix))
            .collect();
        games.extend(fresh);
        cache.save(&games)?;
        Ok(games)
    })
    .await
    .map_err(|e| format!("Rescan failed: {}", e))?
}

#[tauri::command]
pub fn toggle_favorite(
    game_id: String,
    state: State<'_, Mutex<AppState>>,
) -> Result<HashSet<String>, String> {
    let state = state.lock().unwrap();
    let cache = CacheService::new(state.cache_dir.clone());
    let mut favorites = cache.load_favorites();
    if favorites.contains(&game_id) {
        favorites.remove(&game_id);
    } else {
        favorites.insert(game_id);
    }
    cache.save_favorites(&favorites)?;
    Ok(favorites)
}

#[tauri::command]
pub fn get_favorites(state: State<'_, Mutex<AppState>>) -> Result<HashSet<String>, String> {
    let state = state.lock().unwrap();
    let cache = CacheService::new(state.cache_dir.clone());
    Ok(cache.load_favorites())
}

#[tauri::command]
pub fn get_game_details(game_id: String, state: State<'_, Mutex<AppState>>) -> Result<Option<GameEntry>, String> {
    let state = state.lock().unwrap();
    let cache = CacheService::new(state.cache_dir.clone());
    let games = cache.load().unwrap_or_default();
    Ok(games.into_iter().find(|g| g.id == game_id))
}

#[tauri::command]
pub fn get_store_config(state: State<'_, Mutex<AppState>>) -> Result<StoreConfig, String> {
    let state = state.lock().unwrap();
    let config_path = state.cache_dir.join("store_config.json");
    Ok(StoreConfig::load(&config_path))
}

#[tauri::command]
pub fn set_store_config(
    config: StoreConfig,
    state: State<'_, Mutex<AppState>>,
) -> Result<StoreConfig, String> {
    let state = state.lock().unwrap();
    let config_path = state.cache_dir.join("store_config.json");
    config.save(&config_path)?;
    Ok(config)
}

/// Open a URL in the user's default browser. Only http(s) is allowed.
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("Only http(s) URLs are allowed".to_string());
    }
    shell_open(&url).map_err(|e| format!("Failed to open URL: {}", e))
}

/// Reveal an install folder in the OS file manager.
#[tauri::command]
pub fn open_game_folder(path: String) -> Result<(), String> {
    if !std::path::Path::new(&path).exists() {
        return Err(format!("Folder does not exist: {}", path));
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
    }

    #[cfg(not(target_os = "windows"))]
    {
        let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
        std::process::Command::new(opener)
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
    }

    Ok(())
}

/// Percent-encode a string for use inside a URL query parameter.
fn encode_query(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            b' ' => out.push_str("%20"),
            other => out.push_str(&format!("%{:02X}", other)),
        }
    }
    out
}

/// Look up cover art for a game by name using the public Steam store search.
///
/// Many Epic/GOG/custom titles are also sold on Steam, so a name match gives
/// us high-quality `library_600x900` capsule art. Only entries whose portrait
/// art actually exists on the CDN are returned, otherwise the caller would be
/// handed broken image URLs (DLC pages, demos and delisted apps have none).
#[tauri::command]
pub async fn search_steam_covers(name: String) -> Result<Vec<CoverSuggestion>, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    let url = format!(
        "https://store.steampowered.com/api/storesearch/?term={}&cc=us&l=en",
        encode_query(trimmed)
    );

    let client = http_client()?;

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Steam search failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Steam search failed with status {}", response.status()));
    }

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Invalid Steam response: {}", e))?;

    let mut candidates: Vec<(u64, String)> = Vec::new();
    if let Some(items) = json.get("items").and_then(|v| v.as_array()) {
        for item in items.iter().take(5) {
            let id = match item.get("id").and_then(|v| v.as_u64()) {
                Some(id) => id,
                None => continue,
            };
            let title = item
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            candidates.push((id, title));
        }
    }
    if candidates.is_empty() {
        return Ok(Vec::new());
    }

    // Check the portrait art for each candidate in parallel.
    let mut handles = Vec::new();
    for (index, (id, title)) in candidates.into_iter().enumerate() {
        let client = client.clone();
        handles.push(tauri::async_runtime::spawn(async move {
            let cover = format!(
                "https://cdn.cloudflare.steamstatic.com/steam/apps/{}/library_600x900.jpg",
                id
            );
            let has_art = match client.head(&cover).send().await {
                Ok(resp) => resp.status().is_success(),
                Err(_) => false,
            };
            (index, id, title, cover, has_art)
        }));
    }

    let mut found: Vec<(usize, CoverSuggestion)> = Vec::new();
    for handle in handles {
        if let Ok((index, id, title, cover, true)) = handle.await {
            found.push((index, CoverSuggestion { id, name: title, cover }));
        }
    }
    found.sort_by_key(|(index, _)| *index);

    Ok(found.into_iter().map(|(_, suggestion)| suggestion).collect())
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .user_agent(concat!("GameCabinet/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))
}

/// GET a SteamGridDB API route with the user's key and return its `data` array.
async fn sgdb_get(
    client: &reqwest::Client,
    url: &str,
    api_key: &str,
) -> Result<Vec<serde_json::Value>, String> {
    let response = client
        .get(url)
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|e| format!("SteamGridDB request failed: {}", e))?;
    match response.status().as_u16() {
        200 => {}
        401 | 403 => return Err("SteamGridDB rejected the API key".to_string()),
        404 => return Ok(Vec::new()),
        code => return Err(format!("SteamGridDB returned status {}", code)),
    }
    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Invalid SteamGridDB response: {}", e))?;
    Ok(json
        .get("data")
        .and_then(|d| d.as_array())
        .cloned()
        .unwrap_or_default())
}

/// Look up 600x900 portrait art on SteamGridDB, which covers games that aren't
/// sold on Steam. Needs the user's free API key (steamgriddb.com → Preferences
/// → API); the key is only ever sent to SteamGridDB.
#[tauri::command]
pub async fn search_steamgriddb_covers(
    name: String,
    api_key: String,
) -> Result<Vec<CoverSuggestion>, String> {
    let name = name.trim();
    let api_key = api_key.trim();
    if name.is_empty() || api_key.is_empty() {
        return Ok(Vec::new());
    }
    let client = http_client()?;

    let search_url = format!(
        "https://www.steamgriddb.com/api/v2/search/autocomplete/{}",
        encode_query(name)
    );
    let matches = sgdb_get(&client, &search_url, api_key).await?;

    // Fetch grids for the top few matches in parallel, keeping match order.
    let mut handles = Vec::new();
    for game in matches.iter().take(3) {
        let Some(id) = game.get("id").and_then(|v| v.as_u64()) else { continue };
        let title = game
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let client = client.clone();
        let key = api_key.to_string();
        handles.push(tauri::async_runtime::spawn(async move {
            let url = format!(
                "https://www.steamgriddb.com/api/v2/grids/game/{}?dimensions=600x900&types=static&nsfw=false&humor=false",
                id
            );
            let grids = sgdb_get(&client, &url, &key).await;
            (title, grids)
        }));
    }

    let mut out = Vec::new();
    for handle in handles {
        let Ok((title, grids)) = handle.await else { continue };
        // A bad key fails every request the same way; report it once.
        for grid in grids?.iter().take(4) {
            let (Some(id), Some(url)) = (
                grid.get("id").and_then(|v| v.as_u64()),
                grid.get("url").and_then(|v| v.as_str()),
            ) else {
                continue;
            };
            out.push(CoverSuggestion {
                id,
                name: title.clone(),
                cover: url.to_string(),
            });
        }
    }
    Ok(out)
}

/// Total size of every file under `path`, in bytes.
///
/// The walk can take a while on large games, so it runs on the blocking pool
/// rather than the UI thread.
#[tauri::command]
pub async fn get_game_size(path: String) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || compute_dir_size(&path))
        .await
        .map_err(|e| format!("Size lookup failed: {}", e))?
}

fn compute_dir_size(path: &str) -> Result<u64, String> {
    let root = std::path::Path::new(path);
    if !root.exists() {
        return Err("Install folder not found".to_string());
    }
    if root.is_file() {
        return std::fs::metadata(root)
            .map(|m| m.len())
            .map_err(|e| e.to_string());
    }

    let mut total: u64 = 0;
    for entry in walkdir::WalkDir::new(root).into_iter().filter_map(|e| e.ok()) {
        if entry.file_type().is_file() {
            if let Ok(meta) = entry.metadata() {
                total += meta.len();
            }
        }
    }
    Ok(total)
}

fn dir_exists(path: &str) -> bool {
    !path.is_empty() && std::path::Path::new(path).exists()
}

fn reg_string(root: winreg::HKEY, subkey: &str, value: &str) -> Option<String> {
    use winreg::RegKey;
    let key = RegKey::predef(root).open_subkey(subkey).ok()?;
    key.get_value::<String, _>(value).ok()
}

fn reg_key_exists(root: winreg::HKEY, subkey: &str) -> bool {
    use winreg::RegKey;
    RegKey::predef(root).open_subkey(subkey).is_ok()
}

/// Detect which common game launchers are installed on this machine.
#[tauri::command]
pub fn detect_stores() -> Vec<DetectedStore> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};

    let program_data =
        std::env::var("ProgramData").unwrap_or_else(|_| "C:\\ProgramData".to_string());
    let appdata = std::env::var("APPDATA").unwrap_or_default();
    let local_appdata = std::env::var("LOCALAPPDATA").unwrap_or_default();
    let pf = "C:\\Program Files";
    let pf86 = "C:\\Program Files (x86)";

    let mut stores = Vec::new();

    // Steam
    let steam = reg_string(HKEY_CURRENT_USER, "Software\\Valve\\Steam", "SteamPath")
        .map(|p| p.replace('/', "\\"))
        .filter(|p| dir_exists(p))
        .or_else(|| {
            let p = format!("{}\\Steam", pf86);
            if dir_exists(&p) {
                Some(p)
            } else {
                None
            }
        });
    stores.push(DetectedStore {
        id: "steam".into(),
        name: "Steam".into(),
        installed: steam.is_some(),
        path: steam,
    });

    // Epic Games
    let epic = format!(
        "{}\\Epic\\EpicGamesLauncher\\Data\\Manifests",
        program_data
    );
    stores.push(DetectedStore {
        id: "epic".into(),
        name: "Epic Games".into(),
        installed: dir_exists(&epic),
        path: if dir_exists(&epic) { Some(epic) } else { None },
    });

    // GOG Galaxy
    let gog = reg_string(
        HKEY_LOCAL_MACHINE,
        "SOFTWARE\\WOW6432Node\\GOG.com\\GalaxyClient",
        "path",
    )
    .filter(|p| dir_exists(p))
    .or_else(|| {
        let p = format!("{}\\GOG Galaxy", pf86);
        if dir_exists(&p) {
            Some(p)
        } else {
            None
        }
    });
    stores.push(DetectedStore {
        id: "gog".into(),
        name: "GOG Galaxy".into(),
        installed: gog.is_some(),
        path: gog,
    });

    // Battle.net
    let battlenet = {
        let p = format!("{}\\Battle.net", pf86);
        if dir_exists(&p) {
            Some(p)
        } else if reg_key_exists(HKEY_LOCAL_MACHINE, "SOFTWARE\\WOW6432Node\\Blizzard Entertainment") {
            Some(format!("{}\\Battle.net", pf86))
        } else {
            None
        }
    };
    stores.push(DetectedStore {
        id: "battlenet".into(),
        name: "Battle.net".into(),
        installed: battlenet.is_some(),
        path: battlenet,
    });

    // Ubisoft Connect
    let ubisoft = {
        let p = format!("{}\\Ubisoft\\Ubisoft Game Launcher", pf86);
        if dir_exists(&p) {
            Some(p)
        } else if reg_key_exists(HKEY_LOCAL_MACHINE, "SOFTWARE\\WOW6432Node\\Ubisoft") {
            Some(p)
        } else {
            None
        }
    };
    stores.push(DetectedStore {
        id: "ubisoft".into(),
        name: "Ubisoft Connect".into(),
        installed: ubisoft.is_some(),
        path: ubisoft,
    });

    // EA App / Origin
    let ea = {
        let modern = format!("{}\\Electronic Arts\\EA Desktop", pf);
        let legacy = format!("{}\\Origin", pf86);
        if dir_exists(&modern) {
            Some(modern)
        } else if dir_exists(&legacy) {
            Some(legacy)
        } else {
            None
        }
    };
    stores.push(DetectedStore {
        id: "ea".into(),
        name: "EA App".into(),
        installed: ea.is_some(),
        path: ea,
    });

    // Xbox / Microsoft Store
    let xbox = {
        let pkg = format!(
            "{}\\Packages\\Microsoft.GamingApp_8wekyb3d8bbwe",
            local_appdata
        );
        let store_pkg = format!(
            "{}\\Packages\\Microsoft.WindowsStore_8wekyb3d8bbwe",
            local_appdata
        );
        if dir_exists(&pkg) {
            Some(pkg)
        } else if dir_exists(&store_pkg) {
            Some(store_pkg)
        } else {
            None
        }
    };
    stores.push(DetectedStore {
        id: "xbox".into(),
        name: "Xbox".into(),
        installed: xbox.is_some(),
        path: xbox,
    });

    // Amazon Games
    let amazon = {
        let p = format!("{}\\Amazon Games", pf);
        if dir_exists(&p) {
            Some(p)
        } else {
            None
        }
    };
    stores.push(DetectedStore {
        id: "amazon".into(),
        name: "Amazon Games".into(),
        installed: amazon.is_some(),
        path: amazon,
    });

    // itch.io
    let itch = {
        let p = format!("{}\\itch", appdata);
        if dir_exists(&p) {
            Some(p)
        } else {
            None
        }
    };
    stores.push(DetectedStore {
        id: "itch".into(),
        name: "itch.io".into(),
        installed: itch.is_some(),
        path: itch,
    });

    // Rockstar Games Launcher
    let rockstar = {
        let p = format!("{}\\Rockstar Games", pf);
        if dir_exists(&p) {
            Some(p)
        } else {
            None
        }
    };
    stores.push(DetectedStore {
        id: "rockstar".into(),
        name: "Rockstar Games".into(),
        installed: rockstar.is_some(),
        path: rockstar,
    });

    stores
}
