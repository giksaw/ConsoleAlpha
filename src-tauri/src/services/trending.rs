//! Trending lists and game search for the Trending page, from the Steam store.
//!
//! Each list starts as a list of Steam app ids: the store's search page sorted
//! by top sellers / popular new / popular upcoming, or the official most-played
//! chart. One `IStoreBrowseService/GetItems` call then turns the ids into names,
//! cover art, prices (in the user's region) and review summaries. None of this
//! needs an API key. The store search page is undocumented, so every failure
//! comes back as an error for the page to show, never a panic.

use crate::services::http::encode_query;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// How long a fetched list (or search) is reused before asking Steam again.
const LIST_TTL: Duration = Duration::from_secs(30 * 60);
const SEARCH_TTL: Duration = Duration::from_secs(5 * 60);
/// Games shown per list.
const LIST_SIZE: usize = 48;
/// "New & trending" keeps only games released this recently.
const NEW_WINDOW_SECS: i64 = 90 * 86_400;
/// GetItems answers at most this many ids per call.
const ITEMS_PER_CALL: usize = 100;
const ASSET_BASE: &str = "https://shared.akamai.steamstatic.com/store_item_assets/";
/// GetItems `type` for games (others: 4 DLC, 6 software, 10 hardware, ...).
const TYPE_GAME: i64 = 0;

#[derive(Debug, Clone, Serialize)]
pub struct TrendingGame {
    /// Steam app id, as a string like the owned-library `app_id`.
    pub app_id: String,
    pub name: String,
    /// Portrait 600x900 art, then the landscape capsule and header as fallbacks.
    pub covers: Vec<String>,
    pub description: String,
    pub developers: Vec<String>,
    pub publishers: Vec<String>,
    /// Unix seconds. For unreleased games, the planned date.
    pub release_date: Option<i64>,
    pub coming_soon: bool,
    /// How precise Steam says an upcoming date is: "date_full", "date_month",
    /// "date_quarter", "date_year", or something else (show `release_message`).
    pub release_display: Option<String>,
    pub release_message: Option<String>,
    pub early_access: bool,
    pub is_free: bool,
    /// Formatted in the user's currency, e.g. "₹1,649.00".
    pub price: Option<String>,
    pub original_price: Option<String>,
    pub discount_pct: u32,
    /// e.g. "Very Positive"; None when the game has no reviews yet.
    pub review_label: Option<String>,
    pub review_percent: Option<u32>,
    pub review_count: Option<u64>,
}

type Cache = Mutex<HashMap<String, (Instant, Vec<TrendingGame>)>>;

fn cache() -> &'static Cache {
    static CACHE: OnceLock<Cache> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cached(key: &str, ttl: Duration) -> Option<Vec<TrendingGame>> {
    let map = cache().lock().ok()?;
    map.get(key)
        .filter(|(at, _)| at.elapsed() < ttl)
        .map(|(_, games)| games.clone())
}

fn remember(key: String, games: &[TrendingGame]) {
    if let Ok(mut map) = cache().lock() {
        // Searches pile up as the user types; drop anything expired.
        map.retain(|_, (at, _)| at.elapsed() < LIST_TTL);
        map.insert(key, (Instant::now(), games.to_vec()));
    }
}

/// The user's region from Windows' "Country or region" setting, so prices come
/// back in their currency. Falls back to the US store.
pub fn country_code() -> String {
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        let name: Option<String> = winreg::RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey("Control Panel\\International\\Geo")
            .and_then(|key| key.get_value("Name"))
            .ok();
        if let Some(name) = name {
            if name.len() == 2 && name.bytes().all(|b| b.is_ascii_alphabetic()) {
                return name.to_ascii_uppercase();
            }
        }
    }
    "US".to_string()
}

/// One of the Trending page's lists: "top_sellers", "new_trending",
/// "most_played" or "upcoming".
pub async fn list(client: &reqwest::Client, kind: &str) -> Result<Vec<TrendingGame>, String> {
    let cc = country_code();
    let key = format!("list:{}:{}", kind, cc);
    if let Some(games) = cached(&key, LIST_TTL) {
        return Ok(games);
    }

    let games = match kind {
        "top_sellers" => {
            let ids = store_search_ids(client, "filter=topsellers", 0, &cc).await?;
            items(client, &take(ids, LIST_SIZE), &cc).await?
        }
        // Steam's "popular new" list is mostly evergreen hits (CS2, Dota 2), so
        // keep only what actually came out recently.
        "new_trending" => {
            let mut ids = store_search_ids(client, "filter=popularnew", 0, &cc).await?;
            if let Ok(more) = store_search_ids(client, "filter=popularnew", 100, &cc).await {
                ids.extend(more);
            }
            let now = chrono::Utc::now().timestamp();
            let mut games = items(client, &dedupe(ids), &cc).await?;
            games.retain(|g| {
                !g.coming_soon
                    && g.release_date.map_or(false, |d| d <= now && now - d <= NEW_WINDOW_SECS)
            });
            games.truncate(LIST_SIZE);
            games
        }
        "upcoming" => {
            let ids = store_search_ids(client, "filter=popularcomingsoon", 0, &cc).await?;
            items(client, &take(ids, LIST_SIZE), &cc).await?
        }
        "most_played" => {
            let ids = most_played_ids(client).await?;
            items(client, &take(ids, LIST_SIZE), &cc).await?
        }
        other => return Err(format!("Unknown list: {}", other)),
    };

    if !games.is_empty() {
        remember(key, &games);
    }
    Ok(games)
}

/// Search the Steam store for games by name.
pub async fn search(client: &reqwest::Client, query: &str) -> Result<Vec<TrendingGame>, String> {
    let query = query.trim();
    if query.chars().count() < 2 {
        return Ok(Vec::new());
    }
    let cc = country_code();
    let key = format!("search:{}:{}", query.to_lowercase(), cc);
    if let Some(games) = cached(&key, SEARCH_TTL) {
        return Ok(games);
    }
    let ids = store_search_ids(client, &format!("term={}", encode_query(query)), 0, &cc).await?;
    let games = items(client, &take(ids, LIST_SIZE), &cc).await?;
    remember(key, &games);
    Ok(games)
}

fn take(ids: Vec<u64>, n: usize) -> Vec<u64> {
    let mut ids = dedupe(ids);
    ids.truncate(n);
    ids
}

fn dedupe(ids: Vec<u64>) -> Vec<u64> {
    let mut seen = std::collections::HashSet::new();
    ids.into_iter().filter(|id| seen.insert(*id)).collect()
}

async fn get_json(client: &reqwest::Client, url: &str) -> Result<Value, String> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Couldn't reach the Steam store: {}", e))?;
    if !response.status().is_success() {
        return Err(format!("The Steam store answered with status {}", response.status()));
    }
    response
        .json()
        .await
        .map_err(|e| format!("Unexpected answer from the Steam store: {}", e))
}

/// App ids from the store's search page, in its order (up to 100 per page).
/// `category1=998` keeps it to games. `params` is already URL-encoded.
async fn store_search_ids(
    client: &reqwest::Client,
    params: &str,
    start: usize,
    cc: &str,
) -> Result<Vec<u64>, String> {
    let url = format!(
        "https://store.steampowered.com/search/results/?json=1&category1=998&count=100&start={}&cc={}&l=english&{}",
        start,
        encode_query(cc),
        params
    );
    Ok(search_result_ids(&get_json(client, &url).await?))
}

/// The search page's JSON has no app id field, only a capsule image URL with
/// the id in its path (`.../steam/apps/1172470/...`). Bundles and packages
/// (`/bundles/`, `/subs/`) are skipped.
fn search_result_ids(json: &Value) -> Vec<u64> {
    json.get("items")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("logo").and_then(|v| v.as_str()))
                .filter_map(app_id_from_url)
                .collect()
        })
        .unwrap_or_default()
}

fn app_id_from_url(url: &str) -> Option<u64> {
    let rest = &url[url.find("/apps/")? + "/apps/".len()..];
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if rest[digits.len()..].starts_with('/') {
        digits.parse().ok()
    } else {
        None
    }
}

/// The official weekly chart of games by peak concurrent players.
async fn most_played_ids(client: &reqwest::Client) -> Result<Vec<u64>, String> {
    let json = get_json(
        client,
        "https://api.steampowered.com/ISteamChartsService/GetMostPlayedGames/v1/",
    )
    .await?;
    Ok(json
        .pointer("/response/ranks")
        .and_then(|v| v.as_array())
        .map(|ranks| {
            ranks
                .iter()
                .filter_map(|r| r.get("appid").and_then(|v| v.as_u64()))
                .collect()
        })
        .unwrap_or_default())
}

/// Details for app ids, in the given order. Anything that isn't a game
/// (software like Wallpaper Engine, hardware, DLC) or isn't visible is dropped.
async fn items(client: &reqwest::Client, ids: &[u64], cc: &str) -> Result<Vec<TrendingGame>, String> {
    let mut games = Vec::new();
    for chunk in ids.chunks(ITEMS_PER_CALL) {
        let input = json!({
            "ids": chunk.iter().map(|id| json!({ "appid": id })).collect::<Vec<_>>(),
            "context": { "language": "english", "country_code": cc },
            "data_request": {
                "include_assets": true,
                "include_basic_info": true,
                "include_release": true,
                "include_reviews": true,
            },
        });
        let url = format!(
            "https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json={}",
            encode_query(&input.to_string())
        );
        let json = get_json(client, &url).await?;
        if let Some(list) = json.pointer("/response/store_items").and_then(|v| v.as_array()) {
            games.extend(list.iter().filter_map(parse_item));
        }
    }
    let order: HashMap<String, usize> =
        ids.iter().enumerate().map(|(i, id)| (id.to_string(), i)).collect();
    games.sort_by_key(|g| order.get(&g.app_id).copied().unwrap_or(usize::MAX));
    Ok(games)
}

fn parse_item(item: &Value) -> Option<TrendingGame> {
    let ok = item.get("success").and_then(|v| v.as_i64()) == Some(1)
        && item.get("visible").and_then(|v| v.as_bool()).unwrap_or(false)
        && item.get("type").and_then(|v| v.as_i64()).unwrap_or(TYPE_GAME) == TYPE_GAME;
    if !ok {
        return None;
    }
    let app_id = item.get("appid").and_then(|v| v.as_u64())?;
    let name = str_at(item, "/name")?.trim().to_string();
    if name.is_empty() {
        return None;
    }

    let names = |path: &str| -> Vec<String> {
        item.pointer(path)
            .and_then(|v| v.as_array())
            .map(|list| {
                list.iter()
                    .filter_map(|p| p.get("name").and_then(|v| v.as_str()))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    };

    let release = item.get("release");
    let reviews = item.pointer("/reviews/summary_filtered");
    let review_count = reviews
        .and_then(|r| r.get("review_count"))
        .and_then(|v| v.as_u64())
        .filter(|&n| n > 0);
    let purchase = item.get("best_purchase_option");

    Some(TrendingGame {
        app_id: app_id.to_string(),
        name,
        covers: asset_urls(item),
        description: str_at(item, "/basic_info/short_description").unwrap_or("").trim().to_string(),
        developers: names("/basic_info/developers"),
        publishers: names("/basic_info/publishers"),
        release_date: release
            .and_then(|r| r.get("steam_release_date"))
            .and_then(|v| v.as_i64())
            .filter(|&d| d > 0),
        coming_soon: release
            .and_then(|r| r.get("is_coming_soon"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        release_display: str_at(item, "/release/coming_soon_display").map(str::to_string),
        release_message: str_at(item, "/release/custom_release_date_message").map(str::to_string),
        early_access: release
            .and_then(|r| r.get("is_early_access"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        is_free: item.get("is_free").and_then(|v| v.as_bool()).unwrap_or(false),
        price: purchase
            .and_then(|p| p.get("formatted_final_price"))
            .and_then(|v| v.as_str())
            .map(str::to_string),
        original_price: purchase
            .and_then(|p| p.get("formatted_original_price"))
            .and_then(|v| v.as_str())
            .map(str::to_string),
        discount_pct: purchase
            .and_then(|p| p.get("discount_pct"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32,
        review_label: review_count
            .and(reviews.and_then(|r| r.get("review_score_label")).and_then(|v| v.as_str()))
            .map(str::to_string),
        review_percent: review_count
            .and(reviews.and_then(|r| r.get("percent_positive")).and_then(|v| v.as_u64()))
            .map(|p| p as u32),
        review_count,
    })
}

fn str_at<'a>(item: &'a Value, path: &str) -> Option<&'a str> {
    item.pointer(path).and_then(|v| v.as_str()).filter(|s| !s.is_empty())
}

/// Cover URLs, best first. Asset file names are often hashed
/// (`b727…/library_capsule.jpg`), so they're built from the item's own
/// `asset_url_format` rather than guessed.
fn asset_urls(item: &Value) -> Vec<String> {
    let Some(assets) = item.get("assets") else { return Vec::new() };
    let Some(format) = assets.get("asset_url_format").and_then(|v| v.as_str()) else {
        return Vec::new();
    };
    ["library_capsule", "main_capsule", "header"]
        .iter()
        .filter_map(|key| assets.get(*key).and_then(|v| v.as_str()))
        .filter(|file| !file.is_empty())
        .map(|file| format!("{}{}", ASSET_BASE, format.replace("${FILENAME}", file)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_ids_come_from_capsule_urls() {
        let json = json!({ "items": [
            { "name": "Apex Legends™", "logo": "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/1172470/9fbf2ae1/capsule_sm_120.jpg?t=1" },
            { "name": "A bundle", "logo": "https://shared.fastly.steamstatic.com/store_item_assets/steam/bundles/123/abc/capsule.jpg" },
            { "name": "No logo" },
            { "name": "Counter-Strike 2", "logo": "https://cdn.example/steam/apps/730/capsule_sm_120.jpg" },
        ]});
        assert_eq!(search_result_ids(&json), vec![1172470, 730]);
        assert_eq!(app_id_from_url("https://x/steam/apps/12abc/y.jpg"), None);
        assert_eq!(app_id_from_url("https://x/steam/apps//y.jpg"), None);
    }

    #[test]
    fn parses_a_store_item() {
        let item = json!({
            "item_type": 0, "id": 3240220, "success": 1, "visible": true,
            "name": "Grand Theft Auto V Enhanced", "appid": 3240220, "type": 0,
            "assets": {
                "asset_url_format": "steam/apps/3240220/${FILENAME}?t=1741091880",
                "main_capsule": "aa/capsule_616x353.jpg",
                "header": "header.jpg",
                "library_capsule": "394239e5/library_600x900.jpg"
            },
            "basic_info": {
                "short_description": "Experience entertainment blockbusters — now upgraded.",
                "publishers": [{ "name": "Rockstar Games" }],
                "developers": [{ "name": "Rockstar North" }]
            },
            "release": { "steam_release_date": 1741091880 },
            "reviews": { "summary_filtered": {
                "review_count": 233155, "percent_positive": 84, "review_score": 8,
                "review_score_label": "Very Positive"
            }},
            "best_purchase_option": {
                "formatted_final_price": "₹1,649.00", "formatted_original_price": "₹3,299.00",
                "discount_pct": 50
            }
        });
        let g = parse_item(&item).expect("a game");
        assert_eq!(g.app_id, "3240220");
        assert_eq!(g.covers, vec![
            "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3240220/394239e5/library_600x900.jpg?t=1741091880",
            "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3240220/aa/capsule_616x353.jpg?t=1741091880",
            "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3240220/header.jpg?t=1741091880",
        ]);
        assert_eq!(g.description, "Experience entertainment blockbusters — now upgraded.");
        assert_eq!(g.developers, vec!["Rockstar North"]);
        assert_eq!(g.release_date, Some(1741091880));
        assert!(!g.coming_soon);
        assert_eq!(g.price.as_deref(), Some("₹1,649.00"));
        assert_eq!(g.discount_pct, 50);
        assert_eq!(g.review_label.as_deref(), Some("Very Positive"));
        assert_eq!(g.review_count, Some(233155));
    }

    #[test]
    fn drops_non_games_and_empty_reviews() {
        let software = json!({ "success": 1, "visible": true, "appid": 431960, "type": 6, "name": "Wallpaper Engine" });
        assert!(parse_item(&software).is_none());
        let hidden = json!({ "success": 1, "visible": false, "appid": 1, "type": 0, "name": "Gone" });
        assert!(parse_item(&hidden).is_none());

        let upcoming = json!({
            "success": 1, "visible": true, "appid": 5, "type": 0, "name": "Soon",
            "release": { "steam_release_date": 1795798800, "is_coming_soon": true, "coming_soon_display": "date_full" },
            "reviews": { "summary_filtered": { "review_count": 0, "percent_positive": 0, "review_score_label": "No user reviews" } }
        });
        let g = parse_item(&upcoming).expect("a game");
        assert!(g.coming_soon);
        assert_eq!(g.release_display.as_deref(), Some("date_full"));
        assert_eq!(g.review_label, None);
        assert_eq!(g.review_percent, None);
        assert!(g.covers.is_empty());
    }

    /// Hits the real Steam store: `cargo test --lib live_steam -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_steam() {
        tauri::async_runtime::block_on(async {
            let client = crate::services::http::http_client().unwrap();
            println!("region {}", country_code());
            for kind in ["top_sellers", "new_trending", "most_played", "upcoming"] {
                let games = list(&client, kind).await.unwrap();
                let first: Vec<_> = games.iter().take(5).map(|g| (g.name.as_str(), g.price.as_deref(), g.covers.len())).collect();
                println!("{kind}: {} games {:?}", games.len(), first);
                assert!(!games.is_empty(), "{kind} is empty");
            }
            let found = search(&client, "hollow knight").await.unwrap();
            println!("search: {:?}", found.iter().take(5).map(|g| &g.name).collect::<Vec<_>>());
            assert!(found.iter().any(|g| g.app_id == "367520"));
        });
    }
}
