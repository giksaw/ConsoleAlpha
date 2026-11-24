//! Epic games the user owns but hasn't installed, and install progress.
//!
//! - Ownership: `%LOCALAPPDATA%\EpicGamesLauncher\Saved\Data\OC_<account>.dat`,
//!   the launcher's ownership cache (one entry per entitled app — the same
//!   count the launcher logs as "found N entitled apps").
//! - Names and art: `%ProgramData%\Epic\EpicGamesLauncher\Data\Catalog\catcache.bin`
//!   (base64 JSON). It also holds catalog items the user does NOT own, so it's
//!   only ever used to describe games the ownership cache lists.
//! - Installs: `Data\Manifests\*.item` (installed) and `Data\Manifests\Pending\*.item`
//!   (in progress, with the total `InstallSize`). Epic logs no live progress,
//!   so progress is estimated from bytes on disk.

use crate::services::store_library::{InstallStatus, LibraryGame};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Instant;

fn epic_data_dir() -> PathBuf {
    PathBuf::from(std::env::var("ProgramData").unwrap_or_else(|_| "C:\\ProgramData".to_string()))
        .join("Epic")
        .join("EpicGamesLauncher")
        .join("Data")
}

fn launcher_saved_data_dir() -> Option<PathBuf> {
    let local = std::env::var("LOCALAPPDATA").ok()?;
    Some(PathBuf::from(local).join("EpicGamesLauncher").join("Saved").join("Data"))
}

/// An entitlement from the ownership cache.
#[derive(Debug, Clone, PartialEq)]
struct Owned {
    namespace: String,
    catalog_item_id: String,
    app_name: String,
}

// ── Owned games ──────────────────────────────────────────────────────────────

pub fn owned_uninstalled_games() -> Vec<LibraryGame> {
    let Some(owned) = read_ownership_cache() else { return Vec::new() };
    let catalog = read_catalog(&epic_data_dir().join("Catalog").join("catcache.bin"));
    let installed = installed_app_names();

    let mut seen = HashSet::new();
    let mut games: Vec<LibraryGame> = owned
        .into_iter()
        .filter(|o| !installed.contains(&o.app_name) && seen.insert(o.app_name.clone()))
        .filter_map(|o| {
            let item = catalog.get(&o.catalog_item_id)?;
            if !is_base_game(item) {
                return None; // engines, plugins, add-ons, hidden content
            }
            let name = item.get("title")?.as_str()?.trim().to_string();
            if name.is_empty() {
                return None;
            }
            Some(LibraryGame {
                id: format!("epic_{}", o.app_name),
                app_id: format!("{}:{}:{}", o.namespace, o.catalog_item_id, o.app_name),
                store: "epic".to_string(),
                name,
                source: "Epic".to_string(),
                cover_image_path: cover_url(item),
            })
        })
        .collect();
    games.sort_by_key(|g| g.name.to_lowercase());
    games
}

/// The most recently written ownership cache (one per account that signed in).
fn read_ownership_cache() -> Option<Vec<Owned>> {
    let dir = launcher_saved_data_dir()?;
    let newest = fs::read_dir(&dir)
        .ok()?
        .flatten()
        .filter(|e| {
            let n = e.file_name().to_string_lossy().to_string();
            n.starts_with("OC_") && n.ends_with(".dat")
        })
        .max_by_key(|e| e.metadata().and_then(|m| m.modified()).ok())?;
    parse_ownership_cache(&fs::read(newest.path()).ok()?)
}

/// OC_<account>.dat, version 3: u32 version, FString account id, 8 bytes,
/// u32 count, then per entry FString namespace, catalog item id and app name,
/// a u32 flag and a 20-byte hash. FStrings are an i32 length (negative for
/// UTF-16) followed by the null-terminated text.
fn parse_ownership_cache(bytes: &[u8]) -> Option<Vec<Owned>> {
    let mut r = Cursor { bytes, pos: 0 };
    if r.u32()? != 3 {
        return None; // unknown format: show nothing rather than guess
    }
    r.fstring()?;
    r.skip(8)?;
    let count = r.u32()? as usize;
    let mut out = Vec::with_capacity(count.min(10_000));
    for _ in 0..count {
        let namespace = r.fstring()?;
        let catalog_item_id = r.fstring()?;
        let app_name = r.fstring()?;
        let _flag = r.u32()?;
        r.skip(20)?;
        out.push(Owned { namespace, catalog_item_id, app_name });
    }
    Some(out)
}

struct Cursor<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl Cursor<'_> {
    fn take(&mut self, n: usize) -> Option<&[u8]> {
        let end = self.pos.checked_add(n)?;
        let s = self.bytes.get(self.pos..end)?;
        self.pos = end;
        Some(s)
    }

    fn skip(&mut self, n: usize) -> Option<()> {
        self.take(n).map(|_| ())
    }

    fn u32(&mut self) -> Option<u32> {
        self.take(4).map(|b| u32::from_le_bytes(b.try_into().unwrap()))
    }

    fn fstring(&mut self) -> Option<String> {
        let len = self.u32()? as i32;
        if len == 0 {
            return Some(String::new());
        }
        if len < 0 {
            let units = len.checked_neg()? as usize;
            let raw = self.take(units.checked_mul(2)?)?;
            let wide: Vec<u16> = raw.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
            return Some(String::from_utf16_lossy(&wide).trim_end_matches('\0').to_string());
        }
        if len > 1 << 20 {
            return None;
        }
        let raw = self.take(len as usize)?;
        Some(String::from_utf8_lossy(raw).trim_end_matches('\0').to_string())
    }
}

/// catcache.bin items by catalog item id.
fn read_catalog(path: &Path) -> HashMap<String, serde_json::Value> {
    let Ok(raw) = fs::read(path) else { return HashMap::new() };
    let Some(json) = base64_decode(&raw) else { return HashMap::new() };
    let Ok(serde_json::Value::Array(items)) = serde_json::from_slice::<serde_json::Value>(&json) else {
        return HashMap::new();
    };
    items
        .into_iter()
        .filter_map(|item| Some((item.get("id")?.as_str()?.to_string(), item)))
        .collect()
}

/// A standalone game: in the "games" category, not an add-on, and not
/// pointing at a main game of its own.
fn is_base_game(item: &serde_json::Value) -> bool {
    let cats: Vec<&str> = item
        .get("categories")
        .and_then(|c| c.as_array())
        .map(|a| a.iter().filter_map(|c| c.get("path")?.as_str()).collect())
        .unwrap_or_default();
    let main_game = item
        .get("mainGameItem")
        .and_then(|m| m.get("id"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    cats.contains(&"games") && !cats.contains(&"addons") && main_game.is_empty()
}

/// Portrait box art (matches the 2:3 grid), else the wide one.
fn cover_url(item: &serde_json::Value) -> Option<String> {
    let images = item.get("keyImages")?.as_array()?;
    let find = |kind: &str| {
        images
            .iter()
            .find(|i| i.get("type").and_then(|t| t.as_str()) == Some(kind))
            .and_then(|i| i.get("url")?.as_str())
            .map(str::to_string)
    };
    find("DieselGameBoxTall").or_else(|| find("DieselGameBox")).or_else(|| find("Thumbnail"))
}

fn base64_decode(input: &[u8]) -> Option<Vec<u8>> {
    fn val(c: u8) -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a' + 26) as u32),
            b'0'..=b'9' => Some((c - b'0' + 52) as u32),
            b'+' | b'-' => Some(62),
            b'/' | b'_' => Some(63),
            _ => None,
        }
    }
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let mut acc = 0u32;
    let mut bits = 0;
    for &c in input {
        if c == b'=' || c.is_ascii_whitespace() {
            continue;
        }
        acc = (acc << 6) | val(c)?;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

/// AppNames with a finished install manifest.
fn installed_app_names() -> HashSet<String> {
    manifests(&epic_data_dir().join("Manifests"))
        .into_iter()
        .filter(|m| !m.incomplete)
        .map(|m| m.app_name)
        .collect()
}

struct Manifest {
    app_name: String,
    install_location: PathBuf,
    install_size: u64,
    incomplete: bool,
}

fn manifests(dir: &Path) -> Vec<Manifest> {
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    entries
        .flatten()
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("item"))
        .filter_map(|e| {
            let v: serde_json::Value = serde_json::from_str(&fs::read_to_string(e.path()).ok()?).ok()?;
            Some(Manifest {
                app_name: v.get("AppName")?.as_str()?.to_string(),
                install_location: PathBuf::from(v.get("InstallLocation")?.as_str()?),
                install_size: v.get("InstallSize").and_then(|s| s.as_u64()).unwrap_or(0),
                incomplete: v.get("bIsIncompleteInstall").and_then(|b| b.as_bool()).unwrap_or(false),
            })
        })
        .collect()
}

/// `com.epicgames.launcher://apps/<ns>%3A<catalog id>%3A<app name>?action=install`.
/// Epic confirms ownership and opens its install-location picker.
pub fn install_uri(app_id: &str) -> Option<String> {
    let parts: Vec<&str> = app_id.split(':').collect();
    let ok = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c));
    if parts.len() != 3 || !parts.iter().all(|p| ok(p)) {
        return None;
    }
    Some(format!(
        "com.epicgames.launcher://apps/{}%3A{}%3A{}?action=install",
        parts[0], parts[1], parts[2]
    ))
}

// ── Install progress ─────────────────────────────────────────────────────────

/// Recent disk readings per app, to turn into a speed.
static READINGS: Mutex<Option<HashMap<String, Vec<(Instant, u64)>>>> = Mutex::new(None);

/// Speed is averaged over this window: Epic writes in bursts, so a 2 s
/// reading swings between a few hundred KB/s and 20+ MB/s.
const RATE_WINDOW_SECS: f64 = 10.0;

/// Per app: bytes on disk and when that number last changed.
static LAST_CHANGE: Mutex<Option<HashMap<String, (u64, Instant)>>> = Mutex::new(None);

/// No new bytes for this long means the download is paused or cancelled in
/// Epic (a cancelled install leaves its Pending manifest behind). Epic's
/// final verification also writes nothing, but that's caught by `phase` first.
const STALL_SECS: u64 = 60;

pub fn install_status(app_ids: &[String]) -> Vec<InstallStatus> {
    let data = epic_data_dir().join("Manifests");
    let installed: HashSet<String> = manifests(&data)
        .into_iter()
        .filter(|m| !m.incomplete)
        .map(|m| m.app_name)
        .collect();
    let pending: HashMap<String, Manifest> = manifests(&data.join("Pending"))
        .into_iter()
        .map(|m| (m.app_name.clone(), m))
        .collect();

    app_ids
        .iter()
        .map(|id| {
            let app_name = id.rsplit(':').next().unwrap_or("");
            let mut s = InstallStatus::none(id);
            if installed.contains(app_name) {
                s.state = "installed".into();
                s.progress = Some(1.0);
            } else if let Some(m) = pending.get(app_name) {
                let (on_disk, staging) = dir_size(&m.install_location);
                s.bytes_total = (m.install_size > 0).then_some(m.install_size);
                s.bytes_done = Some(on_disk);
                s.progress = s.bytes_total.map(|t| (on_disk as f64 / t as f64).min(0.99));
                let now = Instant::now();
                s.state = phase(on_disk, staging, m.install_size).into();
                let stalled = seconds_unchanged(id, on_disk, now) >= STALL_SECS;
                if s.state == "downloading" {
                    if stalled {
                        s.state = "paused".into();
                    } else {
                        s.rate = rate_for(id, on_disk, now);
                    }
                }
            }
            s
        })
        .collect()
}

/// Epic downloads into `<install>\.egstore\bps` and moves the files into
/// place at the end, then verifies for a while with nothing changing on disk.
/// All bytes present and staging empty means it's in that last stretch.
fn phase(on_disk: u64, staging: u64, install_size: u64) -> &'static str {
    let all_there = install_size > 0 && on_disk as f64 >= install_size as f64 * 0.98;
    if all_there && staging < 1_000_000 {
        "verifying"
    } else {
        "downloading"
    }
}

/// How long the byte count for this app has stayed the same.
fn seconds_unchanged(id: &str, bytes: u64, now: Instant) -> u64 {
    let Ok(mut guard) = LAST_CHANGE.lock() else { return 0 };
    let map = guard.get_or_insert_with(HashMap::new);
    match map.get(id) {
        Some((b, since)) if *b == bytes => now.duration_since(*since).as_secs(),
        _ => {
            map.insert(id.to_string(), (bytes, now));
            0
        }
    }
}

/// Bytes per second over the last RATE_WINDOW_SECS of readings.
fn rate_for(id: &str, bytes: u64, now: Instant) -> Option<f64> {
    let mut guard = READINGS.lock().ok()?;
    let map = guard.get_or_insert_with(HashMap::new);
    // Forget installs that haven't been asked about for a while.
    map.retain(|_, r| r.last().is_some_and(|(t, _)| now.duration_since(*t).as_secs_f64() < 60.0));
    let readings = map.entry(id.to_string()).or_default();
    readings.retain(|(t, _)| now.duration_since(*t).as_secs_f64() <= RATE_WINDOW_SECS);
    let rate = readings.first().and_then(|(t, b)| {
        let secs = now.duration_since(*t).as_secs_f64();
        (secs > 0.5).then(|| bytes.saturating_sub(*b) as f64 / secs)
    });
    readings.push((now, bytes));
    rate
}

/// (all bytes, bytes still in Epic's `.egstore` staging folder).
fn dir_size(path: &Path) -> (u64, u64) {
    let staging_dir = path.join(".egstore");
    walkdir::WalkDir::new(path)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| Some((e.path().starts_with(&staging_dir), e.metadata().ok()?.len())))
        .fold((0, 0), |(all, staged), (in_staging, len)| {
            (all + len, if in_staging { staged + len } else { staged })
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fstring(s: &str) -> Vec<u8> {
        let mut b = ((s.len() + 1) as u32).to_le_bytes().to_vec();
        b.extend(s.as_bytes());
        b.push(0);
        b
    }

    #[test]
    fn parses_ownership_cache() {
        let mut b = 3u32.to_le_bytes().to_vec();
        b.extend(fstring("3162404794fb41e998067558bc5399fc"));
        b.extend([0u8; 8]);
        b.extend(2u32.to_le_bytes());
        for (ns, cat, app) in [("ns1", "cat1", "AppOne"), ("ue", "cat2", "UE_5.2")] {
            b.extend(fstring(ns));
            b.extend(fstring(cat));
            b.extend(fstring(app));
            b.extend(1u32.to_le_bytes());
            b.extend([0u8; 20]);
        }
        let owned = parse_ownership_cache(&b).unwrap();
        assert_eq!(owned.len(), 2);
        assert_eq!(
            owned[0],
            Owned { namespace: "ns1".into(), catalog_item_id: "cat1".into(), app_name: "AppOne".into() }
        );
        assert_eq!(owned[1].app_name, "UE_5.2");

        // Wrong version or truncated data: nothing, not garbage.
        let mut v4 = b.clone();
        v4[0] = 4;
        assert!(parse_ownership_cache(&v4).is_none());
        assert!(parse_ownership_cache(&b[..b.len() - 5]).is_none());
    }

    #[test]
    fn base_games_only() {
        let game: serde_json::Value = serde_json::json!({
            "categories": [{"path": "applications"}, {"path": "games"}],
            "mainGameItem": {"namespace": "", "id": ""}
        });
        let dlc = serde_json::json!({
            "categories": [{"path": "games"}, {"path": "addons"}],
            "mainGameItem": {"namespace": "x", "id": "y"}
        });
        let engine = serde_json::json!({ "categories": [{"path": "engines"}] });
        assert!(is_base_game(&game));
        assert!(!is_base_game(&dlc));
        assert!(!is_base_game(&engine));
    }

    #[test]
    fn install_uri_is_validated() {
        assert_eq!(
            install_uri("207c42b0:446c4af2:7458160f").as_deref(),
            Some("com.epicgames.launcher://apps/207c42b0%3A446c4af2%3A7458160f?action=install")
        );
        assert!(install_uri("a:b").is_none());
        assert!(install_uri("a:b:c&action=launch").is_none());
        assert!(install_uri("a:b:c d").is_none());
    }

    #[test]
    fn verifying_once_everything_is_in_place() {
        // Mid-download: bytes still arriving in staging.
        assert_eq!(phase(300_000_000, 300_000_000, 732_390_457), "downloading");
        // Moved into place, Epic verifying (observed: 732.6 MB on disk, 0.2 MB staged).
        assert_eq!(phase(732_600_000, 200_000, 732_390_457), "verifying");
        // Everything downloaded but still being moved out of staging.
        assert_eq!(phase(733_500_000, 267_100_000, 732_390_457), "downloading");
        // Unknown size never claims to be verifying.
        assert_eq!(phase(10, 0, 0), "downloading");
    }

    #[test]
    fn unchanged_bytes_are_timed() {
        let t0 = Instant::now();
        let at = |s: u64| t0 + std::time::Duration::from_secs(s);
        assert_eq!(seconds_unchanged("t:stall:x", 5, at(0)), 0);
        assert_eq!(seconds_unchanged("t:stall:x", 5, at(30)), 30);
        assert_eq!(seconds_unchanged("t:stall:x", 5, at(61)), 61);
        // Bytes moving again resets the clock.
        assert_eq!(seconds_unchanged("t:stall:x", 6, at(62)), 0);
        assert_eq!(seconds_unchanged("t:stall:x", 6, at(70)), 8);
    }

    #[test]
    fn rate_is_averaged_over_the_window() {
        let t0 = Instant::now();
        let at = |s: u64| t0 + std::time::Duration::from_secs(s);
        assert_eq!(rate_for("t:rate:x", 0, at(0)), None);
        // A burst then a stall: averaged, not 0 or the burst.
        rate_for("t:rate:x", 40_000_000, at(2));
        let r = rate_for("t:rate:x", 40_000_000, at(4)).unwrap();
        assert!((r - 10_000_000.0).abs() < 1.0, "{r}");
        // Readings older than the window drop out.
        let r = rate_for("t:rate:x", 100_000_000, at(14)).unwrap();
        assert!((r - 6_000_000.0).abs() < 1.0, "{r}");
    }

    #[test]
    fn decodes_base64() {
        assert_eq!(base64_decode(b"W3siaWQiOjF9XQ==").unwrap(), br#"[{"id":1}]"#);
    }
}
