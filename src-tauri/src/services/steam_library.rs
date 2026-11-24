//! Steam games the user owns but hasn't installed, and live install progress.
//!
//! Everything is read from the Steam client's own local files, so it needs no
//! login or Web API key:
//! - `appcache/packageinfo.vdf` — the licenses (packages) on this machine and
//!   the app ids each one grants.
//! - `appcache/appinfo.vdf` — every app's name and type ("game", "tool", …).
//! - `logs/content_log.txt` — the download manager's live log: state changes,
//!   phase (downloading/verifying/committing), totals and download rate.
//! - `steamapps/downloading/state_<app>_<depot>.patch` — one 24-byte record per
//!   finished chunk, flushed every few minutes; with the chunk total from the log
//!   it gives a real (if coarse) progress checkpoint.
//!
//! The app manifest's `BytesDownloaded` is only written when a download stops,
//! and Steam preallocates and zero-fills every file up front, so neither can be
//! used for live progress.

use crate::scanners::steam::{extract_vdf_value, get_library_folders, get_steam_path};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// A game in the user's Steam library that isn't installed on this PC.
#[derive(Debug, Clone, Serialize)]
pub struct LibraryGame {
    /// Same id an installed copy gets (`steam_<appid>`), so favorites, hidden
    /// state and covers carry over once it's installed.
    pub id: String,
    pub app_id: String,
    pub name: String,
    pub source: String,
    pub cover_image_path: Option<String>,
}

/// How far a Steam install has got.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct InstallStatus {
    pub app_id: String,
    /// "queued" | "preparing" | "downloading" | "verifying" | "installing" |
    /// "paused" | "installed" | "failed" | "none"
    pub state: String,
    /// 0..1 estimate of the download, when known.
    pub progress: Option<f64>,
    pub bytes_total: Option<u64>,
    pub bytes_done: Option<u64>,
    /// Current download speed in bytes per second, when Steam has reported one.
    pub rate: Option<f64>,
    /// Why the last attempt stopped, for "failed".
    pub message: Option<String>,
}

// ── Owned games ──────────────────────────────────────────────────────────────

/// Every game the logged-in Steam user owns that isn't fully installed.
/// Returns an empty list when Steam or its caches are missing or unreadable.
pub fn owned_uninstalled_games() -> Vec<LibraryGame> {
    let Some(steam) = get_steam_path() else { return Vec::new() };
    let Ok(pkg_bytes) = fs::read(steam.join("appcache").join("packageinfo.vdf")) else {
        return Vec::new();
    };
    let mut owned = owned_app_ids(&pkg_bytes);
    if owned.is_empty() {
        return Vec::new();
    }

    // appcache is shared by every account that has signed in on this PC. With
    // more than one, keep only apps in the current account's library cache.
    if let Some(user_apps) = current_user_library_cache(&steam) {
        owned.retain(|id| user_apps.contains(id));
    }

    let installed = fully_installed_app_ids(&steam);
    owned.retain(|id| !installed.contains(id));

    let Ok(app_bytes) = fs::read(steam.join("appcache").join("appinfo.vdf")) else {
        return Vec::new();
    };
    let infos = app_infos(&app_bytes, &owned);

    let mut games: Vec<LibraryGame> = infos
        .into_iter()
        .filter(|(_, info)| info.kind.eq_ignore_ascii_case("game") && !info.name.trim().is_empty())
        .map(|(app_id, info)| LibraryGame {
            id: format!("steam_{}", app_id),
            app_id: app_id.to_string(),
            name: info.name.trim().to_string(),
            source: "Steam".to_string(),
            cover_image_path: Some(format!(
                "https://cdn.cloudflare.steamstatic.com/steam/apps/{}/library_600x900.jpg",
                app_id
            )),
        })
        .collect();
    games.sort_by_key(|g| g.name.to_lowercase());
    games
}

/// App ids granted by the licenses in packageinfo.vdf. Package 0 is skipped:
/// every account has it, and it holds Spacewar, SDKs and Valve's free games
/// whether or not the user ever added them.
fn owned_app_ids(bytes: &[u8]) -> HashSet<u32> {
    let mut out = HashSet::new();
    for (package_id, kv) in parse_packageinfo(bytes) {
        if package_id == 0 {
            continue;
        }
        // The package's data sits under a key named after its id.
        let body = kv.get(&package_id.to_string()).unwrap_or(&kv);
        if let Some(Kv::Map(apps)) = body.get("appids") {
            for (_, v) in apps {
                if let Some(id) = v.as_u32() {
                    out.insert(id);
                }
            }
        }
    }
    out
}

/// App ids that have a manifest saying "fully installed" in any library folder.
/// A fresh install in progress has a manifest too, but without that flag.
pub(crate) fn fully_installed_app_ids(steam: &Path) -> HashSet<u32> {
    let mut out = HashSet::new();
    for lib in get_library_folders(steam) {
        let Ok(entries) = fs::read_dir(lib.join("steamapps")) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let Some(id) = name
                .strip_prefix("appmanifest_")
                .and_then(|s| s.strip_suffix(".acf"))
                .and_then(|s| s.parse::<u32>().ok())
            else {
                continue;
            };
            let flags = fs::read_to_string(entry.path())
                .ok()
                .and_then(|c| extract_vdf_value(&c, "StateFlags"))
                .and_then(|v| v.parse::<u32>().ok())
                .unwrap_or(0);
            if flags & STATE_FULLY_INSTALLED != 0 {
                out.insert(id);
            }
        }
    }
    out
}

const STATE_FULLY_INSTALLED: u32 = 4;

/// When several Steam accounts have used this PC, the app ids in the current
/// account's per-user library cache. `None` (no filtering) with a single account.
fn current_user_library_cache(steam: &Path) -> Option<HashSet<u32>> {
    let userdata = steam.join("userdata");
    let accounts: Vec<PathBuf> = fs::read_dir(&userdata)
        .ok()?
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().chars().all(|c| c.is_ascii_digit()))
        .map(|e| e.path())
        .collect();
    if accounts.len() < 2 {
        return None;
    }
    let dir = active_account_dir(&accounts)?;
    let ids: HashSet<u32> = fs::read_dir(dir.join("config").join("librarycache"))
        .ok()?
        .flatten()
        .filter_map(|e| {
            e.file_name()
                .to_string_lossy()
                .strip_suffix(".json")
                .and_then(|s| s.parse().ok())
        })
        .collect();
    (!ids.is_empty()).then_some(ids)
}

/// The signed-in account (Steam running), else the most recently used one.
fn active_account_dir(accounts: &[PathBuf]) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        let active: Option<u32> = winreg::RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey("Software\\Valve\\Steam\\ActiveProcess")
            .and_then(|k| k.get_value("ActiveUser"))
            .ok();
        if let Some(id) = active.filter(|&id| id != 0) {
            if let Some(dir) = accounts.iter().find(|p| p.ends_with(id.to_string())) {
                return Some(dir.clone());
            }
        }
    }
    accounts
        .iter()
        .max_by_key(|p| {
            fs::metadata(p.join("config").join("localconfig.vdf"))
                .and_then(|m| m.modified())
                .ok()
        })
        .cloned()
}

struct AppInfo {
    name: String,
    kind: String,
}

/// Name and type for each wanted app id in appinfo.vdf. Entries carry their own
/// length, so unwanted apps are skipped without being parsed.
fn app_infos(bytes: &[u8], wanted: &HashSet<u32>) -> HashMap<u32, AppInfo> {
    let mut out = HashMap::new();
    let mut r = Reader::new(bytes);
    let (Some(magic), Some(_universe)) = (r.u32(), r.u32()) else { return out };
    // v27/v28 store keys inline; v29 (2024+) keys are indexes into a string
    // table at the end of the file. v28 added a second checksum per entry.
    let (has_binary_sha, strings) = match magic {
        0x0756_4427 => (false, None),
        0x0756_4428 => (true, None),
        0x0756_4429 => {
            let Some(offset) = r.i64().and_then(|o| usize::try_from(o).ok()) else { return out };
            match read_string_table(bytes, offset) {
                Some(table) => (true, Some(table)),
                None => return out,
            }
        }
        _ => return out, // a format we don't know yet: show nothing rather than garbage
    };

    loop {
        let Some(app_id) = r.u32() else { break };
        if app_id == 0 {
            break;
        }
        let Some(size) = r.u32() else { break };
        let start = r.pos;
        let end = start.saturating_add(size as usize);
        if end > bytes.len() {
            break;
        }
        if wanted.contains(&app_id) {
            // infostate, last updated, PICS token, sha1, change number[, binary sha1]
            let header = 4 + 4 + 8 + 20 + 4 + if has_binary_sha { 20 } else { 0 };
            let mut entry = Reader::new(&bytes[..end]);
            entry.pos = start + header;
            if let Some(kv) = entry.kv_map(strings.as_deref(), 0) {
                let root = kv.get("appinfo").unwrap_or(&kv);
                if let Some(common) = root.get("common") {
                    let text = |k: &str| common.get(k).and_then(Kv::as_str).unwrap_or("").to_string();
                    out.insert(app_id, AppInfo { name: text("name"), kind: text("type") });
                }
            }
        }
        r.pos = end;
    }
    out
}

fn read_string_table(bytes: &[u8], offset: usize) -> Option<Vec<String>> {
    let mut r = Reader::new(bytes);
    r.pos = offset;
    let count = r.u32()? as usize;
    let mut table = Vec::with_capacity(count.min(1 << 20));
    for _ in 0..count {
        table.push(r.cstr()?);
    }
    Some(table)
}

/// (package id, package data) for every package in packageinfo.vdf.
fn parse_packageinfo(bytes: &[u8]) -> Vec<(u32, Kv)> {
    let mut out = Vec::new();
    let mut r = Reader::new(bytes);
    let (Some(magic), Some(_universe)) = (r.u32(), r.u32()) else { return out };
    // v28 added a PICS access token to each entry.
    let header = match magic {
        0x0656_5527 => 20 + 4,
        0x0656_5528 => 20 + 4 + 8,
        _ => return out,
    };
    loop {
        let Some(id) = r.u32() else { break };
        if id == 0xFFFF_FFFF {
            break;
        }
        r.pos += header; // sha1, change number[, token]
        // Entries have no length prefix: a parse error leaves us lost, so stop.
        let Some(kv) = r.kv_map(None, 0) else { break };
        out.push((id, kv));
    }
    out
}

// ── Binary KeyValues ─────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
enum Kv {
    Map(Vec<(String, Kv)>),
    Str(String),
    Int(i64),
    Other,
}

impl Kv {
    fn get(&self, key: &str) -> Option<&Kv> {
        match self {
            Kv::Map(items) => items
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(key))
                .map(|(_, v)| v),
            _ => None,
        }
    }

    fn as_str(&self) -> Option<&str> {
        match self {
            Kv::Str(s) => Some(s),
            _ => None,
        }
    }

    fn as_u32(&self) -> Option<u32> {
        match self {
            Kv::Int(i) => u32::try_from(*i).ok(),
            Kv::Str(s) => s.parse().ok(),
            _ => None,
        }
    }
}

struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Reader { bytes, pos: 0 }
    }

    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let end = self.pos.checked_add(n)?;
        let slice = self.bytes.get(self.pos..end)?;
        self.pos = end;
        Some(slice)
    }

    fn u8(&mut self) -> Option<u8> {
        self.take(1).map(|b| b[0])
    }

    fn u32(&mut self) -> Option<u32> {
        self.take(4).map(|b| u32::from_le_bytes(b.try_into().unwrap()))
    }

    fn i64(&mut self) -> Option<i64> {
        self.take(8).map(|b| i64::from_le_bytes(b.try_into().unwrap()))
    }

    fn cstr(&mut self) -> Option<String> {
        let rest = self.bytes.get(self.pos..)?;
        let len = rest.iter().position(|&b| b == 0)?;
        let s = String::from_utf8_lossy(&rest[..len]).into_owned();
        self.pos += len + 1;
        Some(s)
    }

    /// A map body, up to and including its end marker.
    fn kv_map(&mut self, strings: Option<&[String]>, depth: usize) -> Option<Kv> {
        if depth > 64 {
            return None; // corrupt data; don't recurse forever
        }
        let mut items = Vec::new();
        loop {
            let t = self.u8()?;
            if t == 0x08 || t == 0x0B {
                return Some(Kv::Map(items));
            }
            let key = match strings {
                Some(table) => table.get(self.u32()? as usize)?.clone(),
                None => self.cstr()?,
            };
            let value = match t {
                0x00 => self.kv_map(strings, depth + 1)?,
                0x01 => Kv::Str(self.cstr()?),
                0x02 => Kv::Int(self.take(4).map(|b| i32::from_le_bytes(b.try_into().unwrap()))? as i64),
                0x03 | 0x04 | 0x06 => {
                    self.take(4)?;
                    Kv::Other
                }
                0x07 => Kv::Int(self.take(8).map(|b| u64::from_le_bytes(b.try_into().unwrap()))? as i64),
                0x0A => Kv::Int(self.i64()?),
                _ => return None,
            };
            items.push((key, value));
        }
    }
}

// ── Install progress ─────────────────────────────────────────────────────────

/// Current install status for each requested app id.
pub fn install_status(app_ids: &[String]) -> Vec<InstallStatus> {
    let Some(steam) = get_steam_path() else {
        return app_ids.iter().map(|id| InstallStatus::none(id)).collect();
    };
    let log = read_log_tail(&steam.join("logs").join("content_log.txt"), 2 * 1024 * 1024);
    let parsed = parse_content_log(&log);
    let installed = fully_installed_app_ids(&steam);
    let libraries = get_library_folders(&steam);
    let now = chrono::Local::now().naive_local();

    app_ids
        .iter()
        .map(|id| {
            let app: u32 = id.parse().unwrap_or(0);
            let patches = patch_files(&libraries, app);
            status_for(id, parsed.apps.get(&app), &parsed, &patches, installed.contains(&app), now)
        })
        .collect()
}

impl InstallStatus {
    fn none(app_id: &str) -> Self {
        InstallStatus {
            app_id: app_id.to_string(),
            state: "none".into(),
            progress: None,
            bytes_total: None,
            bytes_done: None,
            rate: None,
            message: None,
        }
    }
}

/// A chunk-state file: depot id, finished chunks, when it was last written.
struct PatchFile {
    depot: u32,
    chunks_done: u64,
    modified: chrono::NaiveDateTime,
}

fn patch_files(libraries: &[PathBuf], app: u32) -> Vec<PatchFile> {
    let prefix = format!("state_{}_", app);
    let mut out = Vec::new();
    for lib in libraries {
        let Ok(entries) = fs::read_dir(lib.join("steamapps").join("downloading")) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let Some(depot) = name
                .strip_prefix(&prefix)
                .and_then(|s| s.strip_suffix(".patch"))
                .and_then(|s| s.parse().ok())
            else {
                continue;
            };
            let Ok(meta) = entry.metadata() else { continue };
            let modified = meta
                .modified()
                .ok()
                .map(|t| chrono::DateTime::<chrono::Local>::from(t).naive_local())
                .unwrap_or_default();
            // 24-byte header (format tag + manifest id), then 24 bytes per chunk.
            out.push(PatchFile { depot, chunks_done: meta.len().saturating_sub(24) / 24, modified });
        }
    }
    out
}

#[derive(Default, Debug)]
struct AppLog {
    /// Flags from the last "state changed" line, e.g. "Update Required,Update Running,".
    state: String,
    /// Flags from the last "App update changed" line, e.g. "Running Update,Downloading,Staging,".
    phase: String,
    /// Download and stage byte totals from the last "update started" line.
    download_total: Option<u64>,
    stage_total: Option<u64>,
    started_at: Option<chrono::NaiveDateTime>,
    /// Reason from the last "update canceled" line after the last start.
    canceled: Option<String>,
}

#[derive(Default, Debug)]
struct ContentLog {
    apps: HashMap<u32, AppLog>,
    /// Chunks to download per depot ("Downloading N chunks for depot D").
    depot_chunks: HashMap<u32, u64>,
    /// Last reported download rate (bytes/s) and when.
    rate: Option<(f64, chrono::NaiveDateTime)>,
}

fn read_log_tail(path: &Path, max: u64) -> String {
    let Ok(mut f) = fs::File::open(path) else { return String::new() };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    if len > max && f.seek(SeekFrom::Start(len - max)).is_err() {
        return String::new();
    }
    let mut buf = Vec::new();
    let _ = f.read_to_end(&mut buf);
    String::from_utf8_lossy(&buf).into_owned()
}

fn parse_content_log(text: &str) -> ContentLog {
    let mut log = ContentLog::default();
    for line in text.lines() {
        // "[2026-11-24 14:35:57] AppID 3419430 state changed : …"
        let Some(rest) = line.strip_prefix('[') else { continue };
        let Some((stamp, msg)) = rest.split_once("] ") else { continue };
        let Ok(time) = chrono::NaiveDateTime::parse_from_str(stamp, "%Y-%m-%d %H:%M:%S") else {
            continue;
        };

        if let Some(rate) = msg.strip_prefix("Current download rate: ") {
            if let Some(mbps) = rate.strip_suffix(" Mbps").and_then(|v| v.trim().parse::<f64>().ok()) {
                log.rate = Some((mbps * 1_000_000.0 / 8.0, time));
            }
            continue;
        }
        // "Increasing target number of download connections to 9 (rate was 0.000, now 2.330)"
        if let Some(i) = msg.find("now ") {
            if msg.contains("rate was") {
                if let Ok(mbps) = msg[i + 4..].trim_end_matches(')').trim().parse::<f64>() {
                    log.rate = Some((mbps * 1_000_000.0 / 8.0, time));
                }
            }
        }
        // "Downloading 985 chunks for depot 3419431 (538652396572221049)"
        if let Some(rest) = msg.strip_prefix("Downloading ") {
            let mut words = rest.split_whitespace();
            let chunks = words.next().and_then(|w| w.parse::<u64>().ok());
            let depot = rest
                .split("for depot ")
                .nth(1)
                .and_then(|s| s.split_whitespace().next())
                .and_then(|s| s.parse::<u32>().ok());
            if let (Some(c), Some(d)) = (chunks, depot) {
                log.depot_chunks.insert(d, c);
            }
            continue;
        }

        let Some(rest) = msg.strip_prefix("AppID ") else { continue };
        let Some((id, event)) = rest.split_once(' ') else { continue };
        let Ok(app) = id.parse::<u32>() else { continue };
        let entry = log.apps.entry(app).or_default();
        if let Some(flags) = event.strip_prefix("state changed : ") {
            entry.state = flags.trim().to_string();
        } else if let Some(flags) = event.strip_prefix("App update changed : ") {
            entry.phase = flags.trim().to_string();
        } else if let Some(totals) = event.strip_prefix("update started : ") {
            // "download 0/87910304, store 0/0, reuse 0/0, delta 0/0, stage 0/857256652"
            entry.download_total = field_total(totals, "download");
            entry.stage_total = field_total(totals, "stage");
            entry.started_at = Some(time);
            entry.canceled = None;
        } else if let Some(reason) = event.strip_prefix("update canceled : ") {
            entry.canceled = Some(reason.trim().to_string());
        }
    }
    log
}

/// The total from "<name> done/total" in an "update started" line.
fn field_total(totals: &str, name: &str) -> Option<u64> {
    totals.split(',').find_map(|part| {
        let part = part.trim();
        let rest = part.strip_prefix(name)?.trim();
        rest.split_once('/')?.1.trim().parse().ok()
    })
}

fn status_for(
    app_id: &str,
    app: Option<&AppLog>,
    log: &ContentLog,
    patches: &[PatchFile],
    fully_installed: bool,
    now: chrono::NaiveDateTime,
) -> InstallStatus {
    let mut s = InstallStatus::none(app_id);
    let Some(app) = app else {
        if fully_installed {
            s.state = "installed".into();
        }
        return s;
    };
    let has = |flag: &str| app.state.split(',').any(|f| f.trim() == flag);
    let phase_has = |flag: &str| app.phase.split(',').any(|f| f.trim() == flag);
    s.bytes_total = app.download_total;

    let running = has("Update Running");
    if !running && has("Fully Installed") && !has("Update Required") {
        // Trust the manifest over an old log line: the game may have been
        // uninstalled since, with that part of the log rotated away.
        if fully_installed {
            s.state = "installed".into();
            s.progress = Some(1.0);
            s.bytes_done = s.bytes_total;
        }
        return s;
    }
    if !running {
        if let Some(reason) = &app.canceled {
            // Pausing a download in Steam logs it as "Disabled (Suspended)".
            if reason.contains("Suspended") {
                s.state = "paused".into();
            } else {
                s.state = "failed".into();
                s.message = Some(reason.clone());
            }
        } else if has("Update Started") {
            s.state = "paused".into();
        } else if has("Update Queued") {
            s.state = "queued".into();
        } else if fully_installed {
            s.state = "installed".into();
        } else {
            return s; // nothing in progress
        }
        s.progress = chunk_fraction(patches, log);
        s.bytes_done = done_bytes(s.progress, s.bytes_total);
        return s;
    }

    s.state = if phase_has("Downloading") || phase_has("Staging") {
        "downloading"
    } else if phase_has("Verifying Installed") || phase_has("Verifying Staged") || phase_has("Validating") {
        "verifying"
    } else if phase_has("Committing") {
        "installing"
    } else {
        "preparing" // reconfiguring, preallocating, fetching manifests
    }
    .into();

    if s.state != "downloading" {
        if s.state == "verifying" || s.state == "installing" {
            s.progress = Some(1.0);
            s.bytes_done = s.bytes_total;
        }
        return s;
    }

    // Live rate: only trust a report from the last two minutes.
    s.rate = log
        .rate
        .filter(|(_, t)| (now - *t).num_seconds() < 120)
        .map(|(r, _)| r);

    // Checkpoint from the chunk files, then extrapolate at the current rate
    // since the checkpoint was written. Steam rewrites the chunk file about
    // every CHUNK_BATCH chunks, so the truth can't be much more than one batch
    // past the checkpoint: cap there, so a rate that later collapses can't
    // run the bar far ahead. Never claim to be finished.
    let (done, chunks) = chunk_counts(patches, log).unwrap_or((0, 0));
    let checkpoint = if chunks > 0 { done as f64 / chunks as f64 } else { 0.0 };
    let since = patches
        .iter()
        .map(|p| p.modified)
        .max()
        .or(app.started_at)
        .map(|t| (now - t).num_seconds().max(0) as f64)
        .unwrap_or(0.0);
    s.progress = Some(match (s.bytes_total, s.rate) {
        (Some(total), Some(rate)) if total > 0 && chunks > 0 => {
            let ahead = (rate * since / total as f64).min(CHUNK_BATCH / chunks as f64);
            (checkpoint + ahead).min(0.99)
        }
        _ => checkpoint,
    });
    s.bytes_done = done_bytes(s.progress, s.bytes_total);
    s
}

/// How many chunks Steam writes to the chunk file at a time (observed: the
/// file grows in steps of 64–65 records, every 20 s to 4 min depending on speed).
const CHUNK_BATCH: f64 = 64.0;

/// (finished, to download) chunks over the depots that have a chunk file.
fn chunk_counts(patches: &[PatchFile], log: &ContentLog) -> Option<(u64, u64)> {
    let mut done = 0u64;
    let mut total = 0u64;
    for p in patches {
        let t = *log.depot_chunks.get(&p.depot)?;
        done += p.chunks_done.min(t);
        total += t;
    }
    (total > 0).then_some((done, total))
}

/// Finished chunks ÷ chunks to download.
fn chunk_fraction(patches: &[PatchFile], log: &ContentLog) -> Option<f64> {
    chunk_counts(patches, log).map(|(done, total)| done as f64 / total as f64)
}

fn done_bytes(progress: Option<f64>, total: Option<u64>) -> Option<u64> {
    Some((progress? * total? as f64) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(s: &str) -> chrono::NaiveDateTime {
        chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").unwrap()
    }

    /// Binary KV with inline keys: { "<id>" { "appids" { "0" 10, "1" 20 } } }
    fn package_kv(id: u32, apps: &[u32]) -> Vec<u8> {
        let mut b = vec![0x00];
        b.extend(id.to_string().as_bytes());
        b.push(0);
        b.push(0x00);
        b.extend(b"appids\0");
        for (i, a) in apps.iter().enumerate() {
            b.push(0x02);
            b.extend(i.to_string().as_bytes());
            b.push(0);
            b.extend((*a as i32).to_le_bytes());
        }
        b.extend([0x08, 0x08, 0x08]);
        b
    }

    #[test]
    fn packageinfo_skips_package_zero() {
        let mut b = Vec::new();
        b.extend(0x0656_5528u32.to_le_bytes());
        b.extend(1u32.to_le_bytes());
        for (id, apps) in [(0u32, vec![480u32, 440]), (12345, vec![220, 70])] {
            b.extend(id.to_le_bytes());
            b.extend([0u8; 20 + 4 + 8]);
            b.extend(package_kv(id, &apps));
        }
        b.extend(0xFFFF_FFFFu32.to_le_bytes());
        let owned = owned_app_ids(&b);
        assert_eq!(owned, HashSet::from([220, 70]));
    }

    #[test]
    fn unknown_formats_yield_nothing() {
        let mut b = 0x1234_5678u32.to_le_bytes().to_vec();
        b.extend([0u8; 64]);
        assert!(owned_app_ids(&b).is_empty());
        assert!(app_infos(&b, &HashSet::from([1])).is_empty());
        assert!(owned_app_ids(&[]).is_empty());
    }

    #[test]
    fn appinfo_v29_reads_name_and_type() {
        // String table: 0 appinfo, 1 common, 2 name, 3 type
        let mut kv = vec![0x00];
        kv.extend(0u32.to_le_bytes());
        kv.push(0x00);
        kv.extend(1u32.to_le_bytes());
        kv.push(0x01);
        kv.extend(2u32.to_le_bytes());
        kv.extend("Bongo Cat™\0".as_bytes());
        kv.push(0x01);
        kv.extend(3u32.to_le_bytes());
        kv.extend(b"Game\0");
        kv.extend([0x08, 0x08, 0x08]);

        let mut entry = Vec::new();
        entry.extend([0u8; 4 + 4 + 8 + 20 + 4 + 20]);
        entry.extend(&kv);

        let mut body = Vec::new();
        for app in [7u32, 3419430] {
            body.extend(app.to_le_bytes());
            body.extend((entry.len() as u32).to_le_bytes());
            body.extend(&entry);
        }
        body.extend(0u32.to_le_bytes());

        let mut b = Vec::new();
        b.extend(0x0756_4429u32.to_le_bytes());
        b.extend(1u32.to_le_bytes());
        let table_at = 16 + body.len();
        b.extend((table_at as i64).to_le_bytes());
        b.extend(&body);
        b.extend(4u32.to_le_bytes());
        b.extend(b"appinfo\0common\0name\0type\0");

        let infos = app_infos(&b, &HashSet::from([3419430]));
        assert_eq!(infos.len(), 1, "only the wanted app is parsed");
        let info = &infos[&3419430];
        assert_eq!(info.name, "Bongo Cat™");
        assert_eq!(info.kind, "Game");
    }

    const LOG: &str = "\
[2026-11-24 14:35:46] AppID 3419430 state changed : Update Required,Update Queued,Update Running,
[2026-11-24 14:35:57] AppID 3419430 update started : download 0/87910304, store 0/0, reuse 0/0, delta 0/0, stage 0/857256652
[2026-11-24 14:35:57] AppID 3419430 state changed : Update Required,Update Queued,Update Running,Update Started,
[2026-11-24 14:35:57] AppID 3419430 App update changed : Running Update,Downloading,Staging,
[2026-11-24 14:35:57] Downloading 985 chunks for depot 3419431 (538652396572221049)
[2026-11-24 14:44:23] Increasing target number of download connections to 9 (rate was 0.000, now 2.330)
[2026-11-24 14:45:24] Current download rate: 8.000 Mbps
";

    #[test]
    fn downloading_uses_chunk_checkpoint_plus_rate() {
        let log = parse_content_log(LOG);
        let app = log.apps.get(&3419430).unwrap();
        assert_eq!(app.download_total, Some(87_910_304));
        assert_eq!(app.stage_total, Some(857_256_652));
        assert_eq!(log.depot_chunks.get(&3419431), Some(&985));

        let patches = [PatchFile { depot: 3419431, chunks_done: 197, modified: t("2026-11-24 14:45:00") }];
        // 197/985 = 20%, plus 3 s at 1 MB/s of an 87.9 MB download.
        let s = status_for("3419430", Some(app), &log, &patches, false, t("2026-11-24 14:45:03"));
        assert_eq!(s.state, "downloading");
        assert_eq!(s.rate, Some(1_000_000.0));
        let p = s.progress.unwrap();
        assert!((p - (0.2 + 3_000_000.0 / 87_910_304.0)).abs() < 1e-6, "{p}");

        // 30 s at that rate would be +34%, but the next checkpoint is at most
        // one batch (64 of 985 chunks) away, so the estimate stops there.
        let s = status_for("3419430", Some(app), &log, &patches, false, t("2026-11-24 14:45:30"));
        let p = s.progress.unwrap();
        assert!((p - (0.2 + 64.0 / 985.0)).abs() < 1e-6, "{p}");

        // A stale rate isn't used: progress is just the checkpoint.
        let s = status_for("3419430", Some(app), &log, &patches, false, t("2026-11-24 15:30:00"));
        assert_eq!(s.rate, None);
        assert!((s.progress.unwrap() - 0.2).abs() < 1e-9);
    }

    #[test]
    fn finished_paused_and_failed_states() {
        let done = format!(
            "{LOG}[2026-11-24 14:45:50] AppID 3419430 App update changed : Running Update,Committing,\n\
             [2026-11-24 14:45:50] AppID 3419430 state changed : Fully Installed,\n"
        );
        let log = parse_content_log(&done);
        let s = status_for("3419430", log.apps.get(&3419430), &log, &[], true, t("2026-11-24 14:46:00"));
        assert_eq!(s.state, "installed");

        let paused = format!(
            "{LOG}[2026-11-24 14:40:00] AppID 3419430 update canceled : Disabled (Suspended)\n\
             [2026-11-24 14:40:00] AppID 3419430 state changed : Update Required,Update Started,\n"
        );
        let log = parse_content_log(&paused);
        let s = status_for("3419430", log.apps.get(&3419430), &log, &[], false, t("2026-11-24 14:41:00"));
        assert_eq!(s.state, "paused");

        let failed = format!(
            "{LOG}[2026-11-24 14:40:00] AppID 3419430 update canceled : Failed updating depot 3419431 (No connection to content servers)\n\
             [2026-11-24 14:40:00] AppID 3419430 state changed : Update Required,\n"
        );
        let log = parse_content_log(&failed);
        let s = status_for("3419430", log.apps.get(&3419430), &log, &[], false, t("2026-11-24 14:41:00"));
        assert_eq!(s.state, "failed");
        assert!(s.message.unwrap().contains("No connection"));

        let s = status_for("70", None, &log, &[], false, t("2026-11-24 14:41:00"));
        assert_eq!(s.state, "none");
    }
}
