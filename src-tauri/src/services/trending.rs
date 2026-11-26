//! Lists, search and filters for the Trending page, from the Steam store.
//!
//! Most tabs are pages of the store's search (sorted by top sellers / popular
//! new / popular upcoming, or plain search) with the user's filters passed
//! along as search parameters; "most played" is the official chart. Either way
//! one `IStoreBrowseService/GetItems` call per page turns app ids into names,
//! cover art, prices (in the user's region), review summaries, tags, player
//! modes and platforms. Filters the store search can't do itself (review
//! score, max price, release dates — and everything on the chart) are applied
//! to that data here. None of this needs an API key. The store search page is
//! undocumented, so every failure comes back as an error for the page to
//! show, never a panic.

use crate::services::http::encode_query;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// How long a fetched page (or search page) is reused before asking Steam again.
const LIST_TTL: Duration = Duration::from_secs(30 * 60);
const SEARCH_TTL: Duration = Duration::from_secs(5 * 60);
const TAGS_TTL: Duration = Duration::from_secs(24 * 3600);
/// Store search rows asked for per request (the store's own maximum is 100).
const SEARCH_PAGE: usize = 50;
/// Games handed to the page per request from the most-played chart.
const CHART_PAGE: usize = 50;
/// When filters are applied here and throw most of a page away, keep reading
/// store pages until at least this many games are left...
const MIN_FILL: usize = 24;
/// ...but never read more than this many store pages for one request.
const MAX_SEARCH_PAGES: usize = 6;
/// "New & trending" keeps only games released this recently.
const NEW_WINDOW_SECS: i64 = 90 * 86_400;
/// GetItems answers at most this many ids per call.
const ITEMS_PER_CALL: usize = 100;
const ASSET_BASE: &str = "https://shared.akamai.steamstatic.com/store_item_assets/";
/// GetItems `type` for games (others: 4 DLC, 6 software, 10 hardware, ...).
const TYPE_GAME: i64 = 0;
/// Steam store category ("category2") for multi-player games.
const CAT_MULTIPLAYER: u32 = 1;
/// Steam tag id of "Early Access".
const TAG_EARLY_ACCESS: u32 = 493;

/// Store languages: (search page / API name, display name). The index is
/// Steam's ELanguage number, which is what GetItems reports.
pub const LANGUAGES: [(&str, &str); 30] = [
    ("english", "English"),
    ("german", "German"),
    ("french", "French"),
    ("italian", "Italian"),
    ("koreana", "Korean"),
    ("spanish", "Spanish (Spain)"),
    ("schinese", "Simplified Chinese"),
    ("tchinese", "Traditional Chinese"),
    ("russian", "Russian"),
    ("thai", "Thai"),
    ("japanese", "Japanese"),
    ("portuguese", "Portuguese (Portugal)"),
    ("polish", "Polish"),
    ("danish", "Danish"),
    ("dutch", "Dutch"),
    ("finnish", "Finnish"),
    ("norwegian", "Norwegian"),
    ("swedish", "Swedish"),
    ("hungarian", "Hungarian"),
    ("czech", "Czech"),
    ("romanian", "Romanian"),
    ("turkish", "Turkish"),
    ("brazilian", "Portuguese (Brazil)"),
    ("bulgarian", "Bulgarian"),
    ("greek", "Greek"),
    ("arabic", "Arabic"),
    ("ukrainian", "Ukrainian"),
    ("latam", "Spanish (Latin America)"),
    ("vietnamese", "Vietnamese"),
    ("indonesian", "Indonesian"),
];

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
    /// The price in the user's currency's minor unit (cents, paise, ...).
    pub price_cents: Option<u64>,
    pub discount_pct: u32,
    /// e.g. "Very Positive"; None when the game has no reviews yet.
    pub review_label: Option<String>,
    pub review_percent: Option<u32>,
    pub review_count: Option<u64>,
    /// Steam tag ids, most-voted first (up to 20).
    pub tag_ids: Vec<u32>,
    /// Steam store categories: player modes, features, controller support.
    pub categories: Vec<u32>,
    pub windows: bool,
    pub mac: bool,
    pub linux: bool,
    /// Steam Deck: 3 verified, 2 playable, 1 unsupported, None unknown.
    pub deck: Option<u32>,
    pub vr: bool,
    /// Supported languages as ELanguage numbers (indexes into `LANGUAGES`).
    pub languages: Vec<u32>,
}

/// What the Trending page's filter panel asks for. Every field is optional;
/// the default filters nothing.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct StoreFilters {
    /// Tag ids the game must all have.
    pub tags: Vec<u32>,
    /// Tag ids the game must not have.
    pub exclude_tags: Vec<u32>,
    /// Store categories the game must all have (player modes, features).
    pub categories: Vec<u32>,
    /// "win", "mac" or "linux".
    pub os: Option<String>,
    /// Steam Deck ratings to allow: 3 verified, 2 playable.
    pub deck: Vec<u32>,
    pub vr: bool,
    /// A `LANGUAGES` API name, e.g. "japanese".
    pub language: Option<String>,
    /// "free" or "paid".
    pub price: Option<String>,
    /// Highest price, in the user's currency (major units, e.g. rupees).
    pub max_price: Option<f64>,
    pub on_sale: bool,
    pub hide_early_access: bool,
    /// Lowest share of positive reviews, in percent.
    pub min_review_pct: Option<u32>,
    pub min_review_count: Option<u64>,
    /// Released no longer ago than this many days.
    pub released_within_days: Option<u32>,
    pub year_min: Option<i32>,
    pub year_max: Option<i32>,
    /// Search and multiplayer only: "relevance" (search) / "top" (multiplayer),
    /// "released", "name", "price_asc", "price_desc" or "reviews".
    pub sort: Option<String>,
}

/// One page of a tab.
#[derive(Debug, Clone, Serialize)]
pub struct StorePage {
    pub games: Vec<TrendingGame>,
    /// How many matches Steam reports, when that number means something (no
    /// filters had to be applied here).
    pub total: Option<u64>,
    /// Where the next page starts; None at the end.
    pub next_start: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FilterOption {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct FilterOptions {
    /// Steam's user tags, most used first.
    pub tags: Vec<FilterOption>,
    pub languages: Vec<FilterOption>,
}

// ── Caches ──────────────────────────────────────────────────────────────────

struct TtlCache<T>(OnceLock<Mutex<HashMap<String, (Instant, T)>>>);

impl<T: Clone> TtlCache<T> {
    const fn new() -> Self {
        TtlCache(OnceLock::new())
    }

    fn map(&self) -> &Mutex<HashMap<String, (Instant, T)>> {
        self.0.get_or_init(|| Mutex::new(HashMap::new()))
    }

    fn get(&self, key: &str, ttl: Duration) -> Option<T> {
        let map = self.map().lock().ok()?;
        map.get(key).filter(|(at, _)| at.elapsed() < ttl).map(|(_, v)| v.clone())
    }

    fn put(&self, key: String, value: T, keep: Duration) {
        if let Ok(mut map) = self.map().lock() {
            // Pages pile up as the user types and filters; drop anything expired.
            map.retain(|_, (at, _)| at.elapsed() < keep);
            map.insert(key, (Instant::now(), value));
        }
    }
}

static PAGES: TtlCache<StorePage> = TtlCache::new();
static CHART: TtlCache<Vec<TrendingGame>> = TtlCache::new();
static TAGS: TtlCache<Vec<FilterOption>> = TtlCache::new();

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

// ── Tabs ────────────────────────────────────────────────────────────────────

/// A page of one of the Trending page's tabs: "top_sellers", "new_trending",
/// "multiplayer", "most_played", "upcoming", or "search" (with `query`),
/// starting at `start` (0, then the previous page's `next_start`).
pub async fn browse(
    client: &reqwest::Client,
    tab: &str,
    query: &str,
    filters: &StoreFilters,
    start: usize,
) -> Result<StorePage, String> {
    let query = query.trim();
    if tab == "search" && query.chars().count() < 2 {
        return Ok(StorePage { games: Vec::new(), total: Some(0), next_start: None });
    }
    let cc = country_code();
    let key = format!(
        "{}|{}|{}|{}|{}",
        tab,
        query.to_lowercase(),
        serde_json::to_string(filters).unwrap_or_default(),
        start,
        cc
    );
    let ttl = if tab == "search" { SEARCH_TTL } else { LIST_TTL };
    if let Some(page) = PAGES.get(&key, ttl) {
        return Ok(page);
    }

    let page = match tab {
        "most_played" => chart_page(client, filters, start, &cc).await?,
        "top_sellers" | "new_trending" | "upcoming" | "multiplayer" | "search" => {
            search_page(client, tab, query, filters, start, &cc).await?
        }
        other => return Err(format!("Unknown list: {}", other)),
    };

    if !page.games.is_empty() || page.next_start.is_none() {
        PAGES.put(key, page.clone(), LIST_TTL);
    }
    Ok(page)
}

/// The store search's parameters for a tab and filters (already URL-encoded).
fn search_params(tab: &str, query: &str, filters: &StoreFilters) -> String {
    let mut p: Vec<String> = Vec::new();
    let mut categories = filters.categories.clone();
    let sort = filters.sort.as_deref().unwrap_or("");
    match tab {
        "top_sellers" => p.push("filter=topsellers".into()),
        "new_trending" => p.push("filter=popularnew".into()),
        "upcoming" => p.push("filter=popularcomingsoon".into()),
        "multiplayer" => {
            categories.insert(0, CAT_MULTIPLAYER);
            // The store ignores `sort_by` under a `filter`, so a chosen sort
            // browses every multiplayer game instead of the top sellers.
            if sort_by(sort).is_none() {
                p.push("filter=topsellers".into());
            }
        }
        _ => p.push(format!("term={}", encode_query(query))),
    }
    if matches!(tab, "multiplayer" | "search") {
        if let Some(s) = sort_by(sort) {
            p.push(format!("sort_by={}", s));
        }
    }

    let join = |ids: &[u32]| {
        let mut seen = HashSet::new();
        ids.iter().filter(|id| seen.insert(**id)).map(u32::to_string).collect::<Vec<_>>().join(",")
    };
    if !filters.tags.is_empty() {
        p.push(format!("tags={}", encode_query(&join(&filters.tags))));
    }
    let mut untags = filters.exclude_tags.clone();
    if filters.hide_early_access {
        untags.push(TAG_EARLY_ACCESS);
    }
    if !untags.is_empty() {
        p.push(format!("untags={}", encode_query(&join(&untags))));
    }
    if !categories.is_empty() {
        p.push(format!("category2={}", encode_query(&join(&categories))));
    }
    if let Some(os) = filters.os.as_deref().filter(|os| matches!(*os, "win" | "mac" | "linux")) {
        p.push(format!("os={}", os));
    }
    let deck: Vec<u32> = filters.deck.iter().copied().filter(|d| matches!(d, 2 | 3)).collect();
    if !deck.is_empty() {
        p.push(format!("deck_compatibility={}", encode_query(&join(&deck))));
    }
    if filters.vr {
        p.push("vrsupport=401".into());
    }
    if let Some(lang) = language_index(filters.language.as_deref()) {
        p.push(format!("supportedlang={}", LANGUAGES[lang as usize].0));
    }
    match filters.price.as_deref() {
        Some("free") => p.push("maxprice=free".into()),
        Some("paid") => p.push("hidef2p=1".into()),
        _ => {}
    }
    if filters.on_sale {
        p.push("specials=1".into());
    }
    p.join("&")
}

fn sort_by(sort: &str) -> Option<&'static str> {
    Some(match sort {
        "released" => "Released_DESC",
        "name" => "Name_ASC",
        "price_asc" => "Price_ASC",
        "price_desc" => "Price_DESC",
        "reviews" => "Reviews_DESC",
        _ => return None,
    })
}

fn language_index(name: Option<&str>) -> Option<u32> {
    let name = name?;
    LANGUAGES.iter().position(|(api, _)| *api == name).map(|i| i as u32)
}

/// Whether some filters can only be checked here (on the GetItems data), so a
/// store page may come back with fewer games than it had rows.
fn has_local_filters(tab: &str, f: &StoreFilters) -> bool {
    tab == "new_trending"
        || f.price.as_deref() == Some("paid")
        || f.max_price.is_some()
        || f.min_review_pct.is_some()
        || f.min_review_count.is_some()
        || f.released_within_days.is_some()
        || f.year_min.is_some()
        || f.year_max.is_some()
}

async fn search_page(
    client: &reqwest::Client,
    tab: &str,
    query: &str,
    filters: &StoreFilters,
    start: usize,
    cc: &str,
) -> Result<StorePage, String> {
    let params = search_params(tab, query, filters);
    let local = has_local_filters(tab, filters);
    let now = chrono::Utc::now().timestamp();
    let mut games: Vec<TrendingGame> = Vec::new();
    let mut seen = HashSet::new();
    let mut at = start;
    let mut total = 0;
    let mut next = None;
    for _ in 0..MAX_SEARCH_PAGES {
        let (ids, rows, count) = store_search_ids(client, &params, at, cc).await?;
        total = count;
        let ids: Vec<u64> = ids.into_iter().filter(|id| seen.insert(*id)).collect();
        let mut found = items(client, &ids, cc).await?;
        found.retain(|g| local_match(tab, g, filters, now));
        games.extend(found);
        at += SEARCH_PAGE;
        next = if rows > 0 && (at as u64) < count { Some(at) } else { None };
        // Without local filters one store page is one page here.
        if !local || next.is_none() || games.len() >= MIN_FILL {
            break;
        }
    }
    Ok(StorePage {
        games,
        total: if local { None } else { Some(total) },
        next_start: next,
    })
}

/// The filters the store search can't do itself. On a store tab, anything
/// passed as a search parameter is trusted as is (GetItems only lists a game's
/// top 20 tags, so re-checking tags here would wrongly drop games).
fn local_match(tab: &str, g: &TrendingGame, f: &StoreFilters, now: i64) -> bool {
    // Steam's "popular new" list is mostly evergreen hits (CS2, Dota 2), so
    // keep only what actually came out recently.
    if tab == "new_trending"
        && (g.coming_soon || !g.release_date.map_or(false, |d| d <= now && now - d <= NEW_WINDOW_SECS))
    {
        return false;
    }
    if f.price.as_deref() == Some("paid") && (g.is_free || g.price_cents == Some(0)) {
        return false;
    }
    if let Some(max) = f.max_price {
        // Unpriced (unreleased) games can't be said to be under a price.
        let cap = (max.max(0.0) * 100.0).round() as u64;
        if !(g.is_free || g.price_cents.map_or(false, |c| c <= cap)) {
            return false;
        }
    }
    if let Some(min) = f.min_review_pct {
        if g.review_percent.map_or(true, |p| p < min) {
            return false;
        }
    }
    if let Some(min) = f.min_review_count {
        if g.review_count.unwrap_or(0) < min {
            return false;
        }
    }
    if let Some(days) = f.released_within_days {
        let ok = !g.coming_soon
            && g.release_date.map_or(false, |d| d <= now && now - d <= days as i64 * 86_400);
        if !ok {
            return false;
        }
    }
    if f.year_min.is_some() || f.year_max.is_some() {
        let year = g.release_date.and_then(|d| chrono::DateTime::from_timestamp(d, 0)).map(|d| {
            use chrono::Datelike;
            d.year()
        });
        let Some(year) = year else { return false };
        if f.year_min.map_or(false, |y| year < y) || f.year_max.map_or(false, |y| year > y) {
            return false;
        }
    }
    true
}

/// Every filter, checked on GetItems data alone (for the most-played chart,
/// which has no search parameters).
fn full_match(g: &TrendingGame, f: &StoreFilters, now: i64) -> bool {
    if !f.tags.iter().all(|t| g.tag_ids.contains(t)) {
        return false;
    }
    if f.exclude_tags.iter().any(|t| g.tag_ids.contains(t)) {
        return false;
    }
    if f.hide_early_access && (g.early_access || g.tag_ids.contains(&TAG_EARLY_ACCESS)) {
        return false;
    }
    if !f.categories.iter().all(|c| g.categories.contains(c)) {
        return false;
    }
    match f.os.as_deref() {
        Some("win") if !g.windows => return false,
        Some("mac") if !g.mac => return false,
        Some("linux") if !g.linux => return false,
        _ => {}
    }
    if !f.deck.is_empty() && !g.deck.map_or(false, |d| f.deck.contains(&d)) {
        return false;
    }
    if f.vr && !g.vr {
        return false;
    }
    if let Some(lang) = language_index(f.language.as_deref()) {
        if !g.languages.contains(&lang) {
            return false;
        }
    }
    if f.price.as_deref() == Some("free") && !(g.is_free || g.price_cents == Some(0)) {
        return false;
    }
    if f.on_sale && g.discount_pct == 0 {
        return false;
    }
    local_match("most_played", g, f, now)
}

/// The official weekly chart of games by peak concurrent players, filtered.
async fn chart_page(
    client: &reqwest::Client,
    filters: &StoreFilters,
    start: usize,
    cc: &str,
) -> Result<StorePage, String> {
    let key = format!("chart:{}", cc);
    let all = match CHART.get(&key, LIST_TTL) {
        Some(all) => all,
        None => {
            let ids = dedupe(most_played_ids(client).await?);
            let all = items(client, &ids, cc).await?;
            if !all.is_empty() {
                CHART.put(key, all.clone(), LIST_TTL);
            }
            all
        }
    };
    let now = chrono::Utc::now().timestamp();
    let matching: Vec<TrendingGame> = all.into_iter().filter(|g| full_match(g, filters, now)).collect();
    let end = (start + CHART_PAGE).min(matching.len());
    Ok(StorePage {
        games: matching.get(start..end).map(<[_]>::to_vec).unwrap_or_default(),
        total: Some(matching.len() as u64),
        next_start: (end < matching.len()).then_some(end),
    })
}

/// Steam's user tags for the filter panel (cached for a day), and the store
/// languages.
pub async fn filter_options(client: &reqwest::Client) -> Result<FilterOptions, String> {
    let tags = match TAGS.get("tags", TAGS_TTL) {
        Some(tags) => tags,
        None => {
            let json =
                get_json(client, "https://store.steampowered.com/tagdata/populartags/english").await?;
            let tags: Vec<FilterOption> = json
                .as_array()
                .map(|list| {
                    list.iter()
                        .filter_map(|t| {
                            let id = t.get("tagid")?.as_u64()?;
                            let name = t.get("name")?.as_str()?.trim();
                            (!name.is_empty()).then(|| FilterOption { id: id.to_string(), name: name.to_string() })
                        })
                        .collect()
                })
                .unwrap_or_default();
            if !tags.is_empty() {
                TAGS.put("tags".into(), tags.clone(), TAGS_TTL);
            }
            tags
        }
    };
    let languages = LANGUAGES
        .iter()
        .map(|(id, name)| FilterOption { id: id.to_string(), name: name.to_string() })
        .collect();
    Ok(FilterOptions { tags, languages })
}

fn dedupe(ids: Vec<u64>) -> Vec<u64> {
    let mut seen = HashSet::new();
    ids.into_iter().filter(|id| seen.insert(*id)).collect()
}

async fn get_json(client: &reqwest::Client, url: &str) -> Result<Value, String> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Couldn't reach the Steam store: {}", e))?;
    if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err("The Steam store is busy. Wait a moment and try again.".into());
    }
    if !response.status().is_success() {
        return Err(format!("The Steam store answered with status {}", response.status()));
    }
    response
        .json()
        .await
        .map_err(|e| format!("Unexpected answer from the Steam store: {}", e))
}

/// One page of the store's search: the app ids in its order, how many rows
/// the page had (bundles and packages included) and the total match count.
/// `category1=998` keeps it to games. `params` is already URL-encoded.
async fn store_search_ids(
    client: &reqwest::Client,
    params: &str,
    start: usize,
    cc: &str,
) -> Result<(Vec<u64>, usize, u64), String> {
    let url = format!(
        "https://store.steampowered.com/search/results/?infinite=1&category1=998&count={}&start={}&cc={}&l=english&ignore_preferences=1&{}",
        SEARCH_PAGE,
        start,
        encode_query(cc),
        params
    );
    let json = get_json(client, &url).await?;
    if json.get("success").and_then(|v| v.as_i64()).map_or(false, |s| s != 1) {
        return Err("The Steam store couldn't run this search.".into());
    }
    let html = json.get("results_html").and_then(|v| v.as_str()).unwrap_or("");
    let (ids, rows) = search_result_ids(html);
    let total = json.get("total_count").and_then(|v| v.as_u64()).unwrap_or(0);
    Ok((ids, rows, total))
}

/// App ids from the search page's result rows (`data-ds-appid="1172470"`).
/// Bundles and packages list several ids (`"10,20"`) and are skipped, but
/// still counted as rows.
fn search_result_ids(html: &str) -> (Vec<u64>, usize) {
    const ATTR: &str = "data-ds-appid=\"";
    let mut ids = Vec::new();
    let mut rows = 0;
    let mut rest = html;
    while let Some(pos) = rest.find(ATTR) {
        rest = &rest[pos + ATTR.len()..];
        let Some(end) = rest.find('"') else { break };
        rows += 1;
        if let Ok(id) = rest[..end].parse::<u64>() {
            ids.push(id);
        }
        rest = &rest[end..];
    }
    (ids, rows)
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
                "include_platforms": true,
                "include_tag_count": 20,
                "include_supported_languages": true,
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
    let numbers = |path: &str| -> Vec<u32> {
        item.pointer(path)
            .and_then(|v| v.as_array())
            .map(|list| list.iter().filter_map(|n| n.as_u64()).map(|n| n as u32).collect())
            .unwrap_or_default()
    };
    let flag = |path: &str| item.pointer(path).and_then(|v| v.as_bool()).unwrap_or(false);

    let release = item.get("release");
    let reviews = item.pointer("/reviews/summary_filtered");
    let review_count = reviews
        .and_then(|r| r.get("review_count"))
        .and_then(|v| v.as_u64())
        .filter(|&n| n > 0);
    let purchase = item.get("best_purchase_option");

    let mut categories = numbers("/categories/supported_player_categoryids");
    categories.extend(numbers("/categories/feature_categoryids"));
    categories.extend(numbers("/categories/controller_categoryids"));

    let languages = item
        .get("supported_languages")
        .and_then(|v| v.as_array())
        .map(|list| {
            list.iter()
                .filter(|l| l.get("supported").and_then(|v| v.as_bool()).unwrap_or(false))
                .filter_map(|l| l.get("elanguage").and_then(|v| v.as_u64()))
                .map(|n| n as u32)
                .collect()
        })
        .unwrap_or_default();

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
        coming_soon: flag("/release/is_coming_soon"),
        release_display: str_at(item, "/release/coming_soon_display").map(str::to_string),
        release_message: str_at(item, "/release/custom_release_date_message").map(str::to_string),
        early_access: flag("/release/is_early_access"),
        is_free: flag("/is_free"),
        price: purchase
            .and_then(|p| p.get("formatted_final_price"))
            .and_then(|v| v.as_str())
            .map(str::to_string),
        original_price: purchase
            .and_then(|p| p.get("formatted_original_price"))
            .and_then(|v| v.as_str())
            .map(str::to_string),
        // Steam sends this one as a string ("359900").
        price_cents: purchase.and_then(|p| p.get("final_price_in_cents")).and_then(|v| {
            v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        }),
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
        tag_ids: numbers("/tagids"),
        categories,
        windows: flag("/platforms/windows"),
        mac: flag("/platforms/mac"),
        linux: flag("/platforms/steamos_linux"),
        deck: item
            .pointer("/platforms/steam_deck_compat_category")
            .and_then(|v| v.as_u64())
            .filter(|&d| d > 0)
            .map(|d| d as u32),
        vr: item
            .pointer("/platforms/vr_support")
            .and_then(|v| v.as_object())
            .map_or(false, |vr| !vr.is_empty()),
        languages,
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
    fn app_ids_come_from_result_rows() {
        let html = r#"<a href="x" data-ds-itemkey="App_400" data-ds-appid="400" data-ds-tagids="[1]">
            <a data-ds-itemkey="Bundle_1" data-ds-bundleid="1" data-ds-appid="10,20">
            <a data-ds-itemkey="App_620" data-ds-appid="620">"#;
        assert_eq!(search_result_ids(html), (vec![400, 620], 3));
        assert_eq!(search_result_ids(""), (vec![], 0));
    }

    #[test]
    fn filters_become_search_params() {
        let f = StoreFilters {
            tags: vec![19, 1695, 19],
            exclude_tags: vec![597],
            hide_early_access: true,
            categories: vec![9],
            os: Some("linux".into()),
            deck: vec![3, 2],
            vr: true,
            language: Some("japanese".into()),
            price: Some("free".into()),
            on_sale: true,
            sort: Some("reviews".into()),
            ..Default::default()
        };
        assert_eq!(
            search_params("multiplayer", "", &f),
            "sort_by=Reviews_DESC&tags=19%2C1695&untags=597%2C493&category2=1%2C9&os=linux\
             &deck_compatibility=3%2C2&vrsupport=401&supportedlang=japanese&maxprice=free&specials=1"
        );
        assert_eq!(search_params("multiplayer", "", &StoreFilters::default()), "filter=topsellers&category2=1");
        assert_eq!(search_params("top_sellers", "", &f.clone()).split('&').next(), Some("filter=topsellers"));
        // Ranked tabs ignore the sort; search sorts.
        assert!(!search_params("top_sellers", "", &f).contains("sort_by"));
        assert_eq!(
            search_params("search", "hollow knight", &StoreFilters { sort: Some("price_asc".into()), ..Default::default() }),
            "term=hollow%20knight&sort_by=Price_ASC"
        );
    }

    fn game() -> TrendingGame {
        parse_item(&json!({
            "success": 1, "visible": true, "appid": 1, "type": 0, "name": "G", "is_free": false,
            "tagids": [19, 3859], "categories": { "supported_player_categoryids": [1, 9], "controller_categoryids": [28] },
            "platforms": { "windows": true, "steamos_linux": true, "vr_support": {}, "steam_deck_compat_category": 3 },
            "supported_languages": [{ "elanguage": 0, "supported": true }, { "elanguage": 10, "supported": false }],
            "release": { "steam_release_date": 1_700_000_000 },
            "reviews": { "summary_filtered": { "review_count": 500, "percent_positive": 91, "review_score_label": "Very Positive" } },
            "best_purchase_option": { "final_price_in_cents": "49900", "formatted_final_price": "₹499.00", "discount_pct": 20 }
        }))
        .unwrap()
    }

    #[test]
    fn chart_filters_use_item_data() {
        let g = game();
        let now = 1_700_000_000 + 10 * 86_400;
        let yes = |f: StoreFilters| assert!(full_match(&g, &f, now), "{:?}", f);
        let no = |f: StoreFilters| assert!(!full_match(&g, &f, now), "{:?}", f);
        yes(StoreFilters::default());
        yes(StoreFilters { tags: vec![19], categories: vec![1, 28], os: Some("linux".into()), deck: vec![3], ..Default::default() });
        no(StoreFilters { tags: vec![19, 492], ..Default::default() });
        no(StoreFilters { exclude_tags: vec![3859], ..Default::default() });
        no(StoreFilters { os: Some("mac".into()), ..Default::default() });
        no(StoreFilters { deck: vec![2], ..Default::default() });
        no(StoreFilters { vr: true, ..Default::default() });
        yes(StoreFilters { language: Some("english".into()), ..Default::default() });
        no(StoreFilters { language: Some("japanese".into()), ..Default::default() });
        yes(StoreFilters { on_sale: true, price: Some("paid".into()), max_price: Some(499.0), ..Default::default() });
        no(StoreFilters { max_price: Some(498.0), ..Default::default() });
        no(StoreFilters { price: Some("free".into()), ..Default::default() });
        yes(StoreFilters { min_review_pct: Some(90), min_review_count: Some(500), ..Default::default() });
        no(StoreFilters { min_review_pct: Some(95), ..Default::default() });
        yes(StoreFilters { released_within_days: Some(30), year_min: Some(2023), year_max: Some(2023), ..Default::default() });
        no(StoreFilters { released_within_days: Some(7), ..Default::default() });
        no(StoreFilters { year_min: Some(2024), ..Default::default() });
    }

    #[test]
    fn local_filters_on_store_tabs_trust_the_search() {
        let g = game();
        let now = 1_700_000_000 + 10 * 86_400;
        // Tags and platforms were already sent to the store; only checks it
        // can't do remain.
        let f = StoreFilters { tags: vec![492], os: Some("mac".into()), ..Default::default() };
        assert!(local_match("top_sellers", &g, &f, now));
        assert!(!has_local_filters("top_sellers", &f));
        assert!(has_local_filters("new_trending", &f));
        assert!(local_match("new_trending", &g, &f, now));
        assert!(!local_match("new_trending", &g, &f, now + 200 * 86_400));
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
                "final_price_in_cents": "164900", "discount_pct": 50
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
        assert_eq!(g.price_cents, Some(164900));
        assert_eq!(g.discount_pct, 50);
        assert_eq!(g.review_label.as_deref(), Some("Very Positive"));
        assert_eq!(g.review_count, Some(233155));
        assert!(g.tag_ids.is_empty() && g.categories.is_empty() && g.deck.is_none() && !g.vr);
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
            let none = StoreFilters::default();
            println!("region {}", country_code());
            for tab in ["top_sellers", "new_trending", "multiplayer", "most_played", "upcoming"] {
                let page = browse(&client, tab, "", &none, 0).await.unwrap();
                let first: Vec<_> = page.games.iter().take(4).map(|g| (g.name.as_str(), g.price.as_deref())).collect();
                println!("{tab}: {} games, total {:?}, next {:?} {:?}", page.games.len(), page.total, page.next_start, first);
                assert!(!page.games.is_empty(), "{tab} is empty");
                if let Some(next) = page.next_start {
                    let more = browse(&client, tab, "", &none, next).await.unwrap();
                    println!("  page 2: {} games, next {:?}", more.games.len(), more.next_start);
                    assert!(!more.games.is_empty(), "{tab} page 2 is empty");
                }
            }

            // Search pages past the first.
            let found = browse(&client, "search", "hollow knight", &none, 0).await.unwrap();
            println!("search: {:?} total {:?}", found.games.iter().take(5).map(|g| &g.name).collect::<Vec<_>>(), found.total);
            assert!(found.games.iter().any(|g| g.app_id == "367520"));
            let p1 = browse(&client, "search", "portal", &none, 0).await.unwrap();
            let p2 = browse(&client, "search", "portal", &none, p1.next_start.expect("more pages")).await.unwrap();
            println!("portal: {} + {} of {:?}", p1.games.len(), p2.games.len(), p1.total);
            assert!(p2.games.iter().all(|g| !p1.games.iter().any(|h| h.app_id == g.app_id)));

            // Filters.
            let coop = StoreFilters { categories: vec![38], os: Some("linux".into()), ..Default::default() };
            let page = browse(&client, "multiplayer", "", &coop, 0).await.unwrap();
            println!("online co-op on linux: {:?}", page.games.iter().take(5).map(|g| &g.name).collect::<Vec<_>>());
            assert!(page.games.iter().filter(|g| g.categories.contains(&38) && g.linux).count() * 10 >= page.games.len() * 9);

            let cheap = StoreFilters { max_price: Some(500.0), price: Some("paid".into()), min_review_pct: Some(90), ..Default::default() };
            let page = browse(&client, "top_sellers", "", &cheap, 0).await.unwrap();
            println!("cheap & good: {:?}", page.games.iter().take(5).map(|g| (&g.name, &g.price, g.review_percent)).collect::<Vec<_>>());
            assert!(page.games.len() >= MIN_FILL || page.next_start.is_none());
            assert!(page.games.iter().all(|g| g.review_percent.unwrap_or(0) >= 90));

            let chart = StoreFilters { tags: vec![19], language: Some("english".into()), ..Default::default() };
            let page = browse(&client, "most_played", "", &chart, 0).await.unwrap();
            println!("most played action: {} of {:?}", page.games.len(), page.total);
            assert!(!page.games.is_empty());

            let elden = items(&client, &[1245620], "US").await.unwrap();
            let langs: Vec<_> = elden[0].languages.iter().map(|&l| LANGUAGES[l as usize].1).collect();
            println!("elden ring languages: {:?}", langs);
            assert!(langs.contains(&"Japanese") && langs.contains(&"Portuguese (Brazil)"));

            let opts = filter_options(&client).await.unwrap();
            println!("{} tags, first {:?}", opts.tags.len(), opts.tags.iter().take(5).map(|t| &t.name).collect::<Vec<_>>());
            assert!(opts.tags.len() > 100);
        });
    }
}
