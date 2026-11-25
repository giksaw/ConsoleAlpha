//! Torrent availability for the Discover page, read from community catalogs.
//!
//! The catalogs are Hydra-format JSON feeds — a `name` plus a `downloads`
//! array of titles and magnet links — mirrored on GitHub. Each feed is tried
//! on raw.githubusercontent.com first and on the jsDelivr CDN in front of the
//! same repo second: they're different networks, so when one is unreachable
//! (some ISPs blackhole GitHub's CDN IPs) the other usually isn't. Nothing is
//! ever downloaded here and no magnet reaches the screen: a hit only means
//! "some catalog lists a torrent for this title", and the UI sends the user
//! to the source's own website to get it.

use crate::services::http::encode_query;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// How long a fetched catalog is reused before GitHub is asked again.
const FEED_TTL: Duration = Duration::from_secs(6 * 60 * 60);
/// How long one game's answer (including "not found") is reused.
const CHECK_TTL: Duration = Duration::from_secs(30 * 60);

/// One catalog: the file the community mirrors publish it as (tried on
/// GitHub first, jsDelivr second), and where a click on it sends the user.
/// `{q}` in `site` is the percent-encoded game title.
struct Source {
    name: &'static str,
    file: &'static str,
    site: &'static str,
}

/// Torrent-capable catalogs, in the order they're shown when several have
/// the game. Direct-download-only catalogs (SteamRip, GOG, Online-Fix) are
/// deliberately absent: the row promises torrents, not download links.
/// The canonical hydralinks.cloud copies aren't used: they sit behind a
/// Cloudflare challenge a plain HTTP client can't pass.
const SOURCES: &[Source] = &[
    Source {
        name: "FitGirl",
        file: "fitgirl.json",
        site: "https://fitgirl-repacks.site/?s={q}",
    },
    Source {
        name: "DODI",
        file: "dodi.json",
        site: "https://dodi-repacks.site/?s={q}",
    },
    Source {
        name: "Xatab",
        file: "xatab.json",
        // No reliable site search, so fall back to a web search for the title.
        site: "https://www.google.com/search?q={q}+xatab+torrent",
    },
    Source {
        name: "TinyRepacks",
        file: "tinyrepacks.json",
        site: "https://www.google.com/search?q={q}+tinyrepacks+torrent",
    },
];

/// Every place one catalog is published, best first.
fn feed_urls(file: &str) -> [String; 2] {
    [
        format!("https://raw.githubusercontent.com/ArnamentGames/HydraLinks/main/{}", file),
        format!("https://cdn.jsdelivr.net/gh/ArnamentGames/HydraLinks@main/{}", file),
    ]
}

/// A catalog that lists the game. `url` opens that catalog's own website so
/// the user can take the torrent from there.
#[derive(Debug, Clone, Serialize)]
pub struct TorrentSource {
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TorrentCheck {
    pub available: bool,
    pub sources: Vec<TorrentSource>,
}

/// A catalog's titles as (normalized, as published) pairs.
type Entries = Vec<(String, String)>;
type FeedCache = Mutex<HashMap<&'static str, (Instant, Entries)>>;
type CheckCache = Mutex<HashMap<String, (Instant, TorrentCheck)>>;

fn feed_cache() -> &'static FeedCache {
    static CACHE: OnceLock<FeedCache> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn check_cache() -> &'static CheckCache {
    static CACHE: OnceLock<CheckCache> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Whether any catalog lists a torrent for this game. An error means no
/// catalog could be read at all (the caller falls back to plain site
/// searches); a successful `available: false` is a real answer.
pub async fn check(client: &reqwest::Client, name: &str) -> Result<TorrentCheck, String> {
    let query = name.trim();
    let norm = normalize(query);
    if norm.is_empty() {
        return Err("No title to look up".to_string());
    }
    if let Some(hit) = cached_check(&norm) {
        return Ok(hit);
    }

    // The catalogs are fetched together: the first check of a session pays
    // for all four at once, and a dead mirror only costs its own request.
    let mut tasks = Vec::new();
    for source in SOURCES {
        let client = client.clone();
        tasks.push(tauri::async_runtime::spawn(async move {
            (source, load_feed(&client, source).await)
        }));
    }

    let mut checked = 0usize;
    let mut hits: Vec<&Source> = Vec::new();
    for task in tasks {
        let Ok((source, feed)) = task.await else { continue };
        let Some(entries) = feed else { continue };
        checked += 1;
        if entries.iter().any(|(title, _)| title_matches(&norm, title)) {
            hits.push(source);
        }
    }
    if checked == 0 {
        return Err("Couldn't reach the download catalogs".to_string());
    }

    let result = TorrentCheck {
        available: !hits.is_empty(),
        sources: hits
            .iter()
            .map(|s| TorrentSource {
                name: s.name.to_string(),
                url: s.site.replace("{q}", &encode_query(query)),
            })
            .collect(),
    };
    remember_check(norm, &result);
    Ok(result)
}

/// One catalog's titles, cached for `FEED_TTL`. `None` means every mirror
/// was unreachable or isn't in the format we know (never cached, so a bad
/// deploy upstream heals on the next check).
async fn load_feed(client: &reqwest::Client, source: &'static Source) -> Option<Entries> {
    if let Some(entries) = cached_feed(source.name) {
        return Some(entries);
    }
    for url in feed_urls(source.file) {
        let Ok(response) = client.get(&url).send().await else { continue };
        if !response.status().is_success() {
            continue;
        }
        let Ok(json) = response.json::<Value>().await else { continue };
        let entries = parse_feed(&json);
        if entries.is_empty() {
            continue;
        }
        if let Ok(mut map) = feed_cache().lock() {
            map.insert(source.name, (Instant::now(), entries.clone()));
        }
        return Some(entries);
    }
    None
}

/// Titles from a Hydra-format catalog. Only entries that actually offer a
/// magnet or .torrent link count: a catalog may also carry direct-download
/// hosters, which aren't torrents no matter what the row promises.
fn parse_feed(json: &Value) -> Entries {
    let Some(downloads) = json.get("downloads").and_then(Value::as_array) else {
        return Vec::new();
    };
    downloads
        .iter()
        .filter_map(|entry| {
            let title = entry.get("title").and_then(Value::as_str)?;
            let torrent = entry.get("uris").and_then(Value::as_array)?.iter().any(|uri| {
                uri.as_str()
                    .map(|s| s.starts_with("magnet:") || s.ends_with(".torrent"))
                    .unwrap_or(false)
            });
            if !torrent {
                return None;
            }
            let norm = normalize(title);
            if norm.is_empty() {
                return None;
            }
            Some((norm, title.to_string()))
        })
        .collect()
}

/// Lowercase letters and digits, everything else a single space. Non-ASCII
/// letters (Cyrillic titles) are kept so containment still works on them.
fn normalize(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut space = false;
    for ch in s.chars().flat_map(|c| c.to_lowercase()) {
        if ch.is_alphanumeric() {
            out.push(ch);
            space = false;
        } else if !space && !out.is_empty() {
            out.push(' ');
            space = true;
        }
    }
    while out.ends_with(' ') {
        out.pop();
    }
    out
}

/// Whether a catalog title is this game. Catalog titles carry versions,
/// editions and repack tags the game's name doesn't, so the game name has to
/// appear inside one on word boundaries — and not in front of a sequel
/// marker, so "Hades" never claims "Hades II" and vice versa.
fn title_matches(game: &str, title: &str) -> bool {
    if title == game {
        return true;
    }
    // Very short names would match half the catalog.
    if game.chars().count() < 4 {
        return false;
    }
    let Some(start) = title.find(game) else { return false };
    if start > 0 && title.as_bytes()[start - 1] != b' ' {
        return false; // matched inside another word
    }
    let rest = &title[start + game.len()..];
    if rest.is_empty() {
        return true;
    }
    if !rest.starts_with(' ') {
        return false;
    }
    !is_sequel(rest[1..].split(' ').next().unwrap_or(""))
}

/// A trailing version token means a different game: "Hades" vs "Hades II",
/// "Far Cry" vs "Far Cry 6".
fn is_sequel(token: &str) -> bool {
    if token.is_empty() {
        return false;
    }
    if token.chars().all(|c| c.is_ascii_digit()) {
        return true;
    }
    matches!(
        token,
        "ii" | "iii" | "iv" | "vi" | "vii" | "viii" | "ix" | "xi" | "xii"
    )
}

fn cached_feed(name: &str) -> Option<Entries> {
    let map = feed_cache().lock().ok()?;
    map.get(name)
        .filter(|(at, _)| at.elapsed() < FEED_TTL)
        .map(|(_, entries)| entries.clone())
}

fn cached_check(norm: &str) -> Option<TorrentCheck> {
    let map = check_cache().lock().ok()?;
    map.get(norm)
        .filter(|(at, _)| at.elapsed() < CHECK_TTL)
        .map(|(_, check)| check.clone())
}

fn remember_check(norm: String, check: &TorrentCheck) {
    if let Ok(mut map) = check_cache().lock() {
        // Only the checks still worth keeping are carried over.
        map.retain(|_, (at, _)| at.elapsed() < CHECK_TTL);
        map.insert(norm, (Instant::now(), check.clone()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalizes_titles_for_matching() {
        assert_eq!(normalize("Grand Theft Auto V: Enhanced!!"), "grand theft auto v enhanced");
        assert_eq!(normalize("  Hades—II  "), "hades ii");
        assert_eq!(normalize("..."), "");
        // Non-ASCII letters survive so Cyrillic titles still contain their game.
        assert_eq!(normalize("Папка игры"), "папка игры");
    }

    #[test]
    fn matches_titles_with_versions_and_editions() {
        let game = normalize("Hollow Knight");
        assert!(title_matches(&game, &normalize("Hollow Knight")));
        assert!(title_matches(&game, &normalize("Hollow Knight (v1.5.78.1183) [Portable]")));
        assert!(title_matches(
            &normalize("Grand Theft Auto V Enhanced"),
            &normalize("Grand Theft Auto v Enhanced – v1.0.3258 + Online")
        ));
        // A sequel is a different game.
        assert!(!title_matches(&normalize("Hades"), &normalize("Hades II v1.0")));
        assert!(!title_matches(&normalize("Far Cry"), &normalize("Far Cry 6 Gold Edition")));
        assert!(title_matches(&normalize("Hades II"), &normalize("Hades II (v1.0)")));
        // Matching inside a word isn't a match.
        assert!(!title_matches(&normalize("art"), &normalize("Heart of the Forest")));
        // Names too short to search for must be exact.
        assert!(!title_matches(&normalize("it"), &normalize("it takes two")));
    }

    #[test]
    fn reads_only_torrent_entries_from_a_catalog() {
        let feed = json!({
            "name": "Test",
            "downloads": [
                { "title": "Real Game", "uris": ["magnet:?xt=urn:btih:abc"] },
                { "title": "Real Game 2", "uris": ["https://example.com/real.torrent"] },
                { "title": "Hoster Only", "uris": ["gofile.io/x"] },
                { "title": "No uris at all" }
            ]
        });
        let entries = parse_feed(&feed);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].1, "Real Game");
        assert_eq!(entries[1].1, "Real Game 2");
        // Something that isn't a Hydra catalog at all.
        assert!(parse_feed(&json!({ "items": [] })).is_empty());
    }

    /// Hits the real catalogs: `cargo test --lib live_feeds -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_feeds() {
        tauri::async_runtime::block_on(async {
            let client = crate::services::http::http_client().unwrap();
            let result = check(&client, "Hollow Knight").await.unwrap();
            println!("{:?}", result);
            assert!(result.available, "Hollow Knight should be in some catalog");

            let missing = check(&client, "Zxqvbnm Totally Fake Game 12345").await.unwrap();
            assert!(!missing.available);
        });
    }
}
