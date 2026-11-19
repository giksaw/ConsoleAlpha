import { invoke } from "@tauri-apps/api/core";

// ── State ────────────────────────────────────────────────────────────────────
let allGames = [];
let customGames = [];
let currentFilter = "all";
let currentView = "grid";
let searchQuery = "";
let sortBy = "recent";
let favorites = new Set();
let hiddenGames = new Set();      // game ids the user has hidden
let selectedGame = null;
let currentPage = "lib"; // "lib" | "set"
let controllerIndex = 0;
let gameStatuses = {}; // game_id → "backlog" | "playing" | "finished"
let lastLaunched = {}; // game_id → ISO time of the last launch from Cabinet
let menuGame = null;   // game whose three-dot menu is open
let coverGame = null;  // game whose cover dialog is open
let coverPending = { value: null }; // staged cover (data URL) from a picked file
let settings = {
  scan_on_startup: true,
  keep_in_tray: false,
  hide_removed: false,
  show_stores_in_sidebar: true,
  sgdb_key: "",   // SteamGridDB API key (optional) for artwork of non-Steam games
};
let storeConfig = {
  stores: { steam: true, epic: true, gog: true },
};
let detectedStores = []; // [{ id, name, path, installed }] from the backend

// Custom cover art, keyed by game id (persisted in IndexedDB, cached in memory
// so rendering stays synchronous).
const coverOverrides = new Map();
let coverDB = null;

// Cover art resolved by name through the Steam store search, keyed by game id.
// Persisted so we only pay for the lookup once per game.
const coverLookup = new Map();   // id → cover URL ("" means "looked up, no match")
const lookupFailed = new Set();  // ids whose lookup errored this session

// On-disk sizes, keyed by game id. Computed lazily for games the user can see.
const sizes = new Map();         // id → bytes | null | "pending"

// ── DOM refs ─────────────────────────────────────────────────────────────────
const $ = (s) => document.querySelector(s);
const railEl = $("#rail");
const topEl = $("#top");
const scrollEl = $("#sc");
const scrimEl = $("#scrim");
const panelEl = $("#panel");
const dlgEl = $("#dlg");
const covDlgEl = $("#covdlg");
const menuEl = $("#menu");
const padEl = $("#pad");

const isTauri = typeof window !== "undefined" && (
  window.__TAURI__ !== undefined ||
  window.__TAURI_INTERNALS__ !== undefined ||
  (window.__TAURI_METADATA__ !== undefined)
);

// ── Store metadata ───────────────────────────────────────────────────────────
const NAV = [["all", "All games"], ["recent", "Recently played"], ["fav", "Favorites"]];

// The launchers we look for on this machine. `source` is the value the scanners
// put on a game; `supported` is true only for launchers we can actually scan.
const STORE_CATALOG = [
  { id: "steam", name: "Steam", source: "Steam", supported: true },
  { id: "epic", name: "Epic Games", source: "Epic", supported: true },
  { id: "gog", name: "GOG Galaxy", source: "GOG", supported: true },
  { id: "battlenet", name: "Battle.net", source: "BattleNet", supported: true },
  { id: "ubisoft", name: "Ubisoft Connect", source: "Ubisoft", supported: true },
  { id: "ea", name: "EA App", source: "EA", supported: true },
  { id: "xbox", name: "Xbox", source: "Xbox", supported: true },
  { id: "amazon", name: "Amazon Games", source: "Amazon", supported: true },
  { id: "itch", name: "itch.io", source: "itch.io", supported: true },
  { id: "rockstar", name: "Rockstar Games", source: "Rockstar", supported: true },
];

// How to show where a game came from ("Battle.net", not the raw "BattleNet").
function sourceName(game) {
  const store = STORE_CATALOG.find((s) => s.source === game.source);
  return store ? store.name : game.source;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function relativeTime(dateStr) {
  if (!dateStr) return "Never";
  const d = new Date(dateStr);
  const now = new Date();
  const diff = now - d;
  const days = Math.floor(diff / 86400000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) { const w = Math.floor(days / 7); return `${w} week${w > 1 ? "s" : ""} ago`; }
  if (days < 365) { const m = Math.floor(days / 30); return `${m} month${m > 1 ? "s" : ""} ago`; }
  const y = Math.floor(days / 365); return `${y} year${y > 1 ? "s" : ""} ago`;
}

function formatSize(bytes) {
  if (bytes === "pending") return "…";
  if (bytes === null || bytes === undefined) return "—";
  const gb = bytes / 1073741824;
  if (gb >= 1) return (gb >= 10 ? Math.round(gb) : gb.toFixed(1)) + " GB";
  const mb = bytes / 1048576;
  if (mb >= 1) return Math.round(mb) + " MB";
  return Math.max(1, Math.round(bytes / 1024)) + " KB";
}

// ── Cover generation ─────────────────────────────────────────────────────────
const COVER_COLORS = [
  ["#d9482b", "#f4c26b", "#fff"],
  ["#12355b", "#5bc0de", "#fff"],
  ["#2b1b3d", "#c77dbb", "#fff"],
  ["#26292e", "#4b525c", "#e8e5de"],
  ["#1f5a3a", "#bfe3a0", "#fff"],
  ["#1b6ca8", "#f4efe2", "#fff"],
  ["#a8541b", "#2b1b0f", "#fff"],
  ["#7a2f5e", "#f2b8c6", "#fff"],
  ["#141a20", "#59707f", "#e8e5de"],
  ["#f2c230", "#e0662b", "#1b1b1b"],
  ["#e8d9b5", "#c9482b", "#1b1b1b"],
  ["#0f1c1a", "#2f6f5e", "#e8e5de"],
];

function hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h) + str.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

function getCoverGradient(name) {
  const hash = hashCode(name);
  const [c1, c2, ink] = COVER_COLORS[hash % COVER_COLORS.length];
  const p = hash % 5;
  const bgs = [
    `radial-gradient(circle at 72% 28%,${c2} 0 24%,transparent 25%),linear-gradient(170deg,${c1},${c1})`,
    `repeating-linear-gradient(115deg,${c1} 0 22px,${c2} 22px 26px)`,
    `linear-gradient(160deg,${c1} 58%,${c2} 58%)`,
    `radial-gradient(circle at 28% 72%,transparent 0 14%,${c2} 15% 19%,transparent 20% 30%,${c2} 31% 34%,transparent 35%),${c1}`,
    `radial-gradient(${c2} 2px,transparent 2.6px) 0 0/16px 16px,${c1}`,
  ];
  return { background: bgs[p], color: ink };
}

// Ordered list of cover URLs to try for a game: custom override first, then a
// Steam lookup by name, then the store cover and (for Steam) smaller fallbacks.
function coverCandidates(game) {
  const out = [];
  const override = coverOverrides.get(game.id);
  if (override) out.push(override);
  const looked = coverLookup.get(game.id);
  if (looked) out.push(looked);
  if (game.cover_image_path) out.push(game.cover_image_path);

  const m = /^steam_(\d+)$/.exec(game.id || "");
  if (m) {
    const id = m[1];
    out.push(`https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/library_600x900.jpg`);
    out.push(`https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/capsule_616x353.jpg`);
    out.push(`https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/header.jpg`);
  }
  return [...new Set(out.filter(Boolean))];
}

function renderCover(game, extra = "", overlay = "") {
  const name = game.name || "?";
  const cands = coverCandidates(game);
  if (cands.length) {
    const [first, ...rest] = cands;
    const fb = rest.length ? ` data-fb="${esc(rest.join("|"))}"` : "";
    // Real art: keep the cover clean — the title is shown below the card.
    return `<div class="cv ${extra}" style="background:#222">
      <img src="${esc(first)}"${fb} alt="${esc(name)}" loading="lazy">${overlay}
    </div>`;
  }
  // No art available: a generated gradient tile needs its title to make sense.
  const { background, color } = getCoverGradient(name);
  return `<div class="cv ${extra}" style="background:${background};color:${color}">
    <span class="nm">${esc(name)}</span>${overlay}
  </div>`;
}

// Small cover used in the list view (real image, gradient behind it).
function renderThumb(game) {
  const { background } = getCoverGradient(game.name);
  const cands = coverCandidates(game);
  if (cands.length) {
    const [first, ...rest] = cands;
    const fb = rest.length ? ` data-fb="${esc(rest.join("|"))}"` : "";
    return `<span class="th" style="background:${background}"><img src="${esc(first)}"${fb} alt="" loading="lazy"></span>`;
  }
  return `<span class="th" style="background:${background}"></span>`;
}

// Walk the fallback chain when an image fails, then drop to the gradient.
document.addEventListener("error", (e) => {
  const img = e.target;
  if (!img || img.tagName !== "IMG") return;
  const fb = (img.dataset.fb || "").split("|").filter(Boolean);
  if (fb.length) {
    img.dataset.fb = fb.slice(1).join("|");
    img.src = fb[0];
  } else {
    img.remove();
  }
}, true);

// ── Cover lookup (Steam store search, then SteamGridDB) ──────────────────────
// Many Epic/GOG/custom titles are also sold on Steam, and Steam's 600×900
// library art is far better than what those stores expose. Games that aren't on
// Steam fall back to SteamGridDB when the user has added a (free) API key. We
// look the name up once, cache the result, and quietly fill the grid in as
// answers arrive. "No match" answers are retried after MISS_RETRY_MS, or right
// away when the SteamGridDB key changes.
const MISS_RETRY_MS = 14 * 86400000;
const coverMissAt = new Map();   // id → when the lookup last found nothing

function loadCoverLookup() {
  try {
    const raw = localStorage.getItem("cabinet_cover_lookup");
    if (raw) for (const [k, v] of Object.entries(JSON.parse(raw))) coverLookup.set(k, v);
    const miss = localStorage.getItem("cabinet_cover_miss");
    if (miss) for (const [k, v] of Object.entries(JSON.parse(miss))) coverMissAt.set(k, v);
  } catch { /* ignore */ }
}
function saveCoverLookup() {
  try {
    localStorage.setItem("cabinet_cover_lookup", JSON.stringify(Object.fromEntries(coverLookup)));
    localStorage.setItem("cabinet_cover_miss", JSON.stringify(Object.fromEntries(coverMissAt)));
  } catch { /* ignore */ }
}

// Forget every automatic cover so all games are looked up again (e.g. after
// adding a SteamGridDB key). This also replaces Steam's loose guesses from
// earlier lookups; exact Steam matches are simply found again. Covers the user
// picked themselves live in coverOverrides and are untouched.
function forgetAutoCovers() {
  coverLookup.clear();
  coverMissAt.clear();
  lookupFailed.clear();
  saveCoverLookup();
}

// Artwork candidates for a name: Steam first, then SteamGridDB if a key is set.
// Returns { results, error } — error is set only when every source failed.
async function searchArtwork(name) {
  const results = [];
  const errors = [];
  try {
    results.push(...(await invoke("search_steam_covers", { name }) || []));
  } catch (e) { errors.push(String(e)); }
  const apiKey = (settings.sgdb_key || "").trim();
  if (apiKey) {
    try {
      results.push(...(await invoke("search_steamgriddb_covers", { name, apiKey }) || []));
    } catch (e) { errors.push(String(e)); }
  }
  const seen = new Set();
  const unique = results.filter((r) => r && r.cover && !seen.has(r.cover) && seen.add(r.cover));
  return { results: unique, error: unique.length ? null : (errors[0] || null) };
}

function needsCoverLookup(game) {
  if (!isTauri) return false;
  if (coverOverrides.has(game.id)) return false;   // user chose the art
  if (coverLookup.has(game.id)) {                  // already answered…
    if (coverLookup.get(game.id)) return false;
    const missAt = coverMissAt.get(game.id) || 0;  // …unless it was a stale miss
    if (Date.now() - missAt < MISS_RETRY_MS) return false;
  }
  if (lookupFailed.has(game.id)) return false;     // errored this session
  if (/^steam_/.test(game.id || "")) return false; // Steam art is already right
  // Custom games only get auto-art when the user didn't pick any themselves.
  if (game.source === "Custom" && game.cover_image_path) return false;
  return !!game.name;
}

function normalizeName(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[™®©]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Pick the result that best matches the name. `strict` refuses loose matches.
function pickBestMatch(name, results, strict) {
  if (!Array.isArray(results) || !results.length) return null;
  const target = normalizeName(name);
  if (!target) return null;
  let best = results.find((r) => normalizeName(r.name) === target);
  if (best) return best;
  best = results.find((r) => {
    const n = normalizeName(r.name);
    return n.startsWith(target) || target.startsWith(n);
  });
  if (best) return best;
  return strict ? null : results[0];
}

const lookupQueue = [];
let lookingUp = false;
let coverRefreshTimer = null;

function requestCoverLookup(game) {
  if (!needsCoverLookup(game)) return;
  if (lookupQueue.some((g) => g.id === game.id)) return;
  lookupQueue.push(game);
  pumpCoverLookups();
}

async function pumpCoverLookups() {
  if (lookingUp) return;
  lookingUp = true;
  while (lookupQueue.length) {
    const game = lookupQueue.shift();
    if (!needsCoverLookup(game)) continue;
    // Order: an exact/prefix Steam match, then SteamGridDB (if a key is set),
    // and only then Steam's loose top hit. Steam's search is fuzzy, so for a
    // game that isn't on Steam the loose hit is often a different game.
    // Custom games never take a loose hit.
    const allowLoose = game.source !== "Custom";
    let cover = "";
    let steamResults = [];
    try {
      steamResults = await invoke("search_steam_covers", { name: game.name }) || [];
      const exact = pickBestMatch(game.name, steamResults, true);
      cover = exact ? exact.cover : "";
    } catch {
      // Transient failure: skip for now, try again next launch.
      lookupFailed.add(game.id);
      continue;
    }
    const apiKey = (settings.sgdb_key || "").trim();
    if (!cover && apiKey) {
      try {
        const results = await invoke("search_steamgriddb_covers", { name: game.name, apiKey });
        const best = pickBestMatch(game.name, results, !allowLoose);
        cover = best ? best.cover : "";
      } catch {
        // Bad key or network trouble: don't record a miss, retry next launch.
        lookupFailed.add(game.id);
        continue;
      }
    }
    if (!cover && allowLoose && steamResults.length) cover = steamResults[0].cover;
    coverLookup.set(game.id, cover);
    if (cover) coverMissAt.delete(game.id);
    else coverMissAt.set(game.id, Date.now());
    saveCoverLookup();
    scheduleCoverRefresh();
  }
  lookingUp = false;
}

// Re-render once results settle, keeping the scroll position steady.
function scheduleCoverRefresh() {
  clearTimeout(coverRefreshTimer);
  coverRefreshTimer = setTimeout(() => {
    const top = scrollEl.scrollTop;
    renderAll();
    scrollEl.scrollTop = top;
  }, 250);
}

// ── On-disk size ─────────────────────────────────────────────────────────────
// Sizes are exact but require walking the folder, so we only measure games the
// user can actually see and do it one at a time.
const sizeQueue = [];
let sizing = false;

const sizeObserver = ("IntersectionObserver" in window)
  ? new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const game = baseGames().find((g) => g.id === entry.target.dataset.size);
        if (game) requestSize(game);
        sizeObserver.unobserve(entry.target);
      }
    }, { root: scrollEl, rootMargin: "300px" })
  : null;

function observeSizeCells() {
  if (!sizeObserver) return;
  sizeObserver.disconnect();
  document.querySelectorAll("[data-size]").forEach((el) => {
    const game = baseGames().find((g) => g.id === el.dataset.size);
    if (game && game.install_path) sizeObserver.observe(el);
  });
}

// Measured sizes are also saved between sessions, so a big game isn't walked
// again every launch. A saved size is reused for SIZE_MAX_AGE_MS, and only
// while the game's install folder is unchanged; older ones are shown right away
// and re-measured in the background.
const SIZE_MAX_AGE_MS = 7 * 86400000;
const savedSizes = new Map();    // id → { b: bytes, p: install_path, t: measured at }

function loadSavedSizes() {
  try {
    const raw = localStorage.getItem("cabinet_sizes");
    if (raw) for (const [k, v] of Object.entries(JSON.parse(raw))) savedSizes.set(k, v);
  } catch { /* ignore */ }
}
function persistSavedSizes() {
  try { localStorage.setItem("cabinet_sizes", JSON.stringify(Object.fromEntries(savedSizes))); }
  catch { /* ignore */ }
}
function savedSizeFor(game) {
  const s = savedSizes.get(game.id);
  return s && s.p === game.install_path && typeof s.b === "number" ? s : null;
}

function sizeLabel(game) {
  if (!isTauri || !game.install_path) return "—";
  const v = sizes.get(game.id);
  if (typeof v === "number" || v === null) return formatSize(v);
  const saved = savedSizeFor(game);
  if (saved) return formatSize(saved.b);   // shown while a re-measure runs
  return "…";
}

function requestSize(game) {
  if (!isTauri || !game.install_path) return;
  if (sizes.has(game.id) || sizeQueue.some((g) => g.id === game.id)) return;
  const saved = savedSizeFor(game);
  if (saved && Date.now() - saved.t < SIZE_MAX_AGE_MS) {
    sizes.set(game.id, saved.b);
    return;
  }
  sizes.set(game.id, "pending");
  sizeQueue.push(game);
  pumpSizes();
}

async function pumpSizes() {
  if (sizing) return;
  sizing = true;
  while (sizeQueue.length) {
    const game = sizeQueue.shift();
    try {
      const bytes = await invoke("get_game_size", { path: game.install_path });
      sizes.set(game.id, bytes);
      savedSizes.set(game.id, { b: bytes, p: game.install_path, t: Date.now() });
    } catch {
      sizes.set(game.id, null);
      savedSizes.delete(game.id);
    }
    persistSavedSizes();
    refreshSizeCells(game.id);
  }
  sizing = false;
}

function refreshSizeCells(id) {
  const game = baseGames().find((g) => g.id === id);
  if (!game) return;
  document.querySelectorAll(`[data-size="${id}"]`).forEach((el) => {
    el.textContent = sizeLabel(game);
  });
}

// ── Visibility / filtering ───────────────────────────────────────────────────
// Every game we know about, regardless of visibility settings.
function baseGames() {
  return [...allGames, ...customGames];
}

// Games shown for a given filter. "All games", "Uninstalled" and "Hidden" always
// show their full set, so a title can never vanish from the library entirely.
// Explicitly hidden games only appear under the Hidden collection.
function getDisplayGames(filter = currentFilter) {
  let games = baseGames();
  if (filter !== "hidden") games = games.filter((g) => !hiddenGames.has(g.id));
  const alwaysShow = filter === "all" || filter === "uninstalled" || filter === "hidden";
  if (settings.hide_removed && !alwaysShow) {
    games = games.filter((g) => g.is_installed !== false);
  }
  return games;
}

// When a game was last played: the store's own record (Steam) or the last launch
// from Cabinet, whichever is newer. Epic, GOG and local games only have the latter.
function lastPlayed(game) {
  const a = game.last_played ? Date.parse(game.last_played) : NaN;
  const b = lastLaunched[game.id] ? Date.parse(lastLaunched[game.id]) : NaN;
  const t = Math.max(isNaN(a) ? -Infinity : a, isNaN(b) ? -Infinity : b);
  return t === -Infinity ? null : new Date(t).toISOString();
}

function matchGame(game, filter) {
  if (filter === "all") return true;
  if (filter === "fav") return favorites.has(game.id);
  if (filter === "recent") {
    const played = lastPlayed(game);
    if (!played) return false;
    const days = (Date.now() - Date.parse(played)) / 86400000;
    return days <= 7;
  }
  if (filter === "local") return game.source === "Custom";
  if (filter === "uninstalled") return game.is_installed === false;
  if (filter === "hidden") return hiddenGames.has(game.id);
  return game.source === filter;
}

function getFilteredGames() {
  let games = getDisplayGames().filter((g) => matchGame(g, currentFilter));
  if (searchQuery) {
    games = games.filter((g) => g.name.toLowerCase().includes(searchQuery));
  }
  if (sortBy === "az") games.sort((a, b) => a.name.localeCompare(b.name));
  else if (sortBy === "recent") games.sort((a, b) => {
    const pa = lastPlayed(a), pb = lastPlayed(b);
    if (!pa && !pb) return a.name.localeCompare(b.name);
    if (!pa) return 1;
    if (!pb) return -1;
    return Date.parse(pb) - Date.parse(pa);
  });
  return games;
}

// ── Persistence (localStorage) ───────────────────────────────────────────────
function loadCustomGames() {
  try {
    const raw = localStorage.getItem("cabinet_custom_games");
    if (raw) customGames = JSON.parse(raw);
  } catch { /* ignore */ }
}
function saveCustomGames() {
  localStorage.setItem("cabinet_custom_games", JSON.stringify(customGames));
}

function loadSettings() {
  try {
    const raw = localStorage.getItem("cabinet_settings");
    if (raw) settings = { ...settings, ...JSON.parse(raw) };
  } catch { /* ignore */ }
}
function saveSettings() {
  localStorage.setItem("cabinet_settings", JSON.stringify(settings));
}

function loadGameStatuses() {
  try {
    const raw = localStorage.getItem("cabinet_game_statuses");
    if (raw) gameStatuses = JSON.parse(raw);
  } catch { /* ignore */ }
}
function saveGameStatuses() {
  localStorage.setItem("cabinet_game_statuses", JSON.stringify(gameStatuses));
}

function loadLastLaunched() {
  try {
    const raw = localStorage.getItem("cabinet_last_launched");
    if (raw) lastLaunched = JSON.parse(raw) || {};
  } catch { /* ignore */ }
}
function recordLaunch(id) {
  lastLaunched[id] = new Date().toISOString();
  try { localStorage.setItem("cabinet_last_launched", JSON.stringify(lastLaunched)); }
  catch { /* ignore */ }
}

function loadHiddenGames() {
  try {
    const raw = localStorage.getItem("cabinet_hidden_games");
    if (raw) hiddenGames = new Set(JSON.parse(raw));
  } catch { /* ignore */ }
}
function saveHiddenGames() {
  localStorage.setItem("cabinet_hidden_games", JSON.stringify([...hiddenGames]));
}

// ── Cover overrides (IndexedDB) ──────────────────────────────────────────────
function openCoverDB() {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null);
    let req;
    try { req = indexedDB.open("cabinet", 1); } catch { return resolve(null); }
    req.onupgradeneeded = () => req.result.createObjectStore("covers");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

async function loadCoverOverrides() {
  coverDB = await openCoverDB();
  if (!coverDB) return;
  await new Promise((resolve) => {
    const tx = coverDB.transaction("covers", "readonly");
    const req = tx.objectStore("covers").openCursor();
    req.onsuccess = (e) => {
      const cur = e.target.result;
      if (cur) { coverOverrides.set(cur.key, cur.value); cur.continue(); }
    };
    tx.oncomplete = resolve;
    tx.onerror = resolve;
  });
}

function setCoverOverride(id, value) {
  coverOverrides.set(id, value);
  if (coverDB) {
    try { coverDB.transaction("covers", "readwrite").objectStore("covers").put(value, id); }
    catch { /* ignore */ }
  }
}

function clearCoverOverride(id) {
  coverOverrides.delete(id);
  if (coverDB) {
    try { coverDB.transaction("covers", "readwrite").objectStore("covers").delete(id); }
    catch { /* ignore */ }
  }
}

// ── Tauri commands ───────────────────────────────────────────────────────────
async function loadFavorites() {
  if (!isTauri) return;
  try {
    const favs = await invoke("get_favorites");
    favorites = new Set(favs);
  } catch { /* ignore */ }
}

async function loadCachedGames() {
  if (!isTauri) return;
  try {
    const cached = await invoke("get_cached_games");
    if (cached && cached.length > 0) allGames = cached;
  } catch { /* ignore */ }
}

async function loadDetectedStores() {
  if (!isTauri) return;
  try {
    const detected = await invoke("detect_stores");
    if (Array.isArray(detected)) detectedStores = detected;
  } catch { /* ignore */ }
}

async function loadStoreConfig() {
  if (!isTauri) {
    try {
      const raw = localStorage.getItem("cabinet_store_config");
      if (raw) storeConfig = JSON.parse(raw);
    } catch { /* ignore */ }
    return;
  }
  try {
    const config = await invoke("get_store_config");
    if (config && config.stores) storeConfig = config;
  } catch { /* ignore */ }
}

async function saveStoreConfig() {
  if (!isTauri) {
    localStorage.setItem("cabinet_store_config", JSON.stringify(storeConfig));
    return;
  }
  try {
    await invoke("set_store_config", { config: storeConfig });
  } catch (e) {
    console.error("Failed to save store config:", e);
  }
}

// Scan every enabled store. With { quiet: true } (startup refresh) the saved
// library stays on screen while the scan runs and no toast is shown.
async function scanGames({ quiet = false } = {}) {
  if (!isTauri) {
    if (!quiet) toast("Tauri not available — running in browser mode");
    return;
  }
  // Only the library view shows the "Scanning…" placeholder; on the settings
  // page it would wipe the form the user is looking at.
  const showProgress = currentPage === "lib" && (!quiet || allGames.length === 0);
  if (showProgress) scrollEl.innerHTML = `<div class="empty">Scanning your game library…</div>`;
  try {
    const result = await invoke("scan_all_games");
    allGames = Array.isArray(result) ? result : [];
    console.log("[SCAN] allGames set to", allGames.length, "games");
    sizes.clear();
    renderAll();
    if (!quiet) toast(`Found ${allGames.length} games`);
  } catch (e) {
    console.error("Scan failed:", e);
    if (showProgress) {
      scrollEl.innerHTML = `<div class="empty">Scan failed: ${esc(e.message || e)}. Check that Steam is installed.</div>`;
    } else {
      toast("Library refresh failed");
    }
  }
}

async function launchGame(game) {
  if (!isTauri) {
    toast("Launching " + game.name + " (browser mode)");
    return;
  }
  try {
    await invoke("launch_game", { game });
    recordLaunch(game.id);
    toast("Launching " + game.name);
    renderAll();
  } catch (e) {
    console.error("Launch failed:", e);
    toast("Failed to launch: " + e);
  }
}

async function toggleFavorite(gameId) {
  if (!isTauri) {
    if (favorites.has(gameId)) favorites.delete(gameId);
    else favorites.add(gameId);
    renderAll();
    return;
  }
  try {
    const newFavs = await invoke("toggle_favorite", { gameId });
    favorites = new Set(newFavs);
    renderAll();
  } catch (e) {
    console.error("Toggle favorite failed:", e);
  }
}

// The tray behavior lives in the backend (it intercepts the window close), but
// the setting is stored here, so push it on startup and whenever it changes.
async function syncTraySetting() {
  if (!isTauri) return;
  try { await invoke("set_keep_in_tray", { enabled: !!settings.keep_in_tray }); }
  catch (e) { console.error("Failed to update tray setting:", e); }
}

async function openExternal(url) {
  if (!isTauri) { window.open(url, "_blank"); return; }
  try { await invoke("open_url", { url }); }
  catch { toast("Couldn't open link"); }
}

async function openGameFolder(game) {
  const path = game.install_path;
  if (!path) { toast("No folder known for this game"); return; }
  if (!isTauri) { toast("Opening folders needs the desktop app"); return; }
  try { await invoke("open_game_folder", { path }); }
  catch (e) { toast("Couldn't open folder"); }
}

// ── Rendering ────────────────────────────────────────────────────────────────
function renderRail() {
  const cnt = (f) => getDisplayGames(f).filter((g) => matchGame(g, f)).length;
  let html = `<h4>Library</h4>`;
  for (const [k, l] of NAV) {
    html += `<button class="ri ${currentPage === "lib" && currentFilter === k ? "on" : ""}" data-f="${k}">${l}<em>${cnt(k)}</em></button>`;
  }
  if (settings.show_stores_in_sidebar !== false) {
    const rows = STORE_CATALOG
      .filter((s) => storeConfig.stores[s.id] !== false)
      .map((s) => ({ s, n: cnt(s.source) }))
      .filter((r) => r.n > 0);
    if (rows.length) {
      html += `<h4>Stores</h4>`;
      for (const { s, n } of rows) {
        html += `<button class="ri ${currentPage === "lib" && currentFilter === s.source ? "on" : ""}" data-f="${esc(s.source)}">${esc(s.name)}<em>${n}</em></button>`;
      }
    }
  }
  html += `<h4>Collections</h4>`;
  html += `<button class="ri ${currentPage === "lib" && currentFilter === "local" ? "on" : ""}" data-f="local">Local Games<em>${cnt("local")}</em></button>`;
  html += `<button class="ri ${currentPage === "lib" && currentFilter === "uninstalled" ? "on" : ""}" data-f="uninstalled">Uninstalled<em>${cnt("uninstalled")}</em></button>`;
  if (hiddenGames.size > 0) {
    html += `<button class="ri ${currentPage === "lib" && currentFilter === "hidden" ? "on" : ""}" data-f="hidden">Hidden<em>${cnt("hidden")}</em></button>`;
  }
  html += `<h4>App</h4>`;
  html += `<button class="ri ${currentPage === "set" ? "on" : ""}" data-pg="set">Sources &amp; settings</button>`;
  html += `<button class="ri" data-pad>Controller mode</button>`;
  railEl.innerHTML = html;
}

function renderTop() {
  if (currentPage === "set") {
    topEl.innerHTML = `<h1>Sources &amp; settings</h1>`;
    return;
  }
  const titles = { all: "All games", recent: "Recently played", fav: "Favorites", local: "Local Games", uninstalled: "Uninstalled", hidden: "Hidden" };
  const t = titles[currentFilter] || currentFilter;
  const games = getFilteredGames();
  topEl.innerHTML = `<h1>${t}</h1><span class="n">${games.length}</span>
    <input class="q" id="q" placeholder="Search games" value="${esc(searchQuery)}" aria-label="Search games">
    <select class="sel" id="so" aria-label="Sort">
      <option value="recent">Recently played</option>
      <option value="az">A to Z</option>
    </select>
    <div class="vt"><button data-v="grid" class="${currentView === "grid" ? "on" : ""}">Grid</button><button data-v="list" class="${currentView === "list" ? "on" : ""}">List</button></div>
    <button class="btn o" id="add">Add game</button>`;
  $("#so").value = sortBy;
}

function renderLibrary() {
  renderTop();
  const games = getFilteredGames();
  let h;
  if (!games.length) {
    const msg = searchQuery
      ? `No games match "${esc(searchQuery)}". Check the spelling, or add it manually.`
      : `Nothing here yet. Add a game, or rescan in Sources &amp; settings.`;
    h = `<div class="empty">${msg}</div>`;
  } else if (currentView === "grid") {
    h = `<div class="grid">` + games.map((g) => `
      <button class="g" data-id="${esc(g.id)}">
        ${renderCover(g, "", `<span class="play" data-play="${esc(g.id)}">Play</span>`)}
        <div class="grow">
          <b>${esc(g.name)}</b>
          <span class="dots" data-menu="${esc(g.id)}" role="button" tabindex="0" aria-label="Options for ${esc(g.name)}">&#8942;</span>
        </div>
        <span>${esc(sourceName(g))}${hiddenGames.has(g.id) ? " · hidden" : ""}</span>
      </button>`).join("") + `</div>`;
  } else {
    h = `<table class="tbl"><thead><tr><th></th><th>Name</th><th>Store</th><th class="r">Size</th><th>Last played</th><th></th><th></th></tr></thead><tbody>`
      + games.map((g) => `
        <tr data-id="${esc(g.id)}">
          <td>${renderThumb(g)}</td>
          <td>${esc(g.name)}</td>
          <td>${esc(sourceName(g))}</td>
          <td class="r" data-size="${esc(g.id)}">${esc(sizeLabel(g))}</td>
          <td>${relativeTime(lastPlayed(g))}</td>
          <td class="r"><button class="btn" data-play="${esc(g.id)}" style="padding:5px 14px">Play</button></td>
          <td class="r"><button class="dots-inline" data-menu="${esc(g.id)}" aria-label="Options for ${esc(g.name)}">&#8942;</button></td>
        </tr>`).join("") + `</tbody></table>`;
  }
  scrollEl.innerHTML = h;

  // Fill in anything that needs the network or the disk, lazily.
  if (isTauri) {
    games.forEach(requestCoverLookup);
    if (currentView === "list") observeSizeCells();
  }

  const qi = $("#q");
  if (qi) {
    qi.oninput = (e) => {
      searchQuery = e.target.value.toLowerCase();
      const p = qi.selectionStart;
      renderLibrary();
      const n = $("#q");
      if (n) { n.focus(); n.setSelectionRange(p, p); }
    };
  }
  const so = $("#so");
  if (so) so.onchange = (e) => { sortBy = e.target.value; renderLibrary(); };
}

function renderSettings() {
  renderTop();
  const games = baseGames();
  const enabledStores = storeConfig.stores;
  const detectedFor = (id) => detectedStores.find((d) => d.id === id);

  const srcRow = (store) => {
    const on = enabledStores[store.id] !== false;
    const det = detectedFor(store.id);
    const installed = det ? det.installed : null;
    const count = games.filter((g) => g.source === store.source).length;

    let desc;
    if (det && det.path && installed) desc = det.path;
    else if (installed === true) desc = "Installed";
    else if (installed === false) desc = "Not detected on this PC";
    else desc = "Detection unavailable in the browser preview";

    let status;
    if (!on) status = "Hidden — this store won't be scanned or shown.";
    else if (!store.supported) status = "Detected — game scanning for this launcher isn't supported yet.";
    else if (count) status = `${count} games found`;
    else if (installed === false) status = "No games found — launcher not detected.";
    else status = "No games found yet.";

    const dotClass = installed === false ? "off" : "";
    return `<div class="src"><div><b><i class="dot ${dotClass}"></i>${esc(store.name)}</b></div>
      <button class="tg ${on ? "on" : ""}" data-store="${store.id}" aria-pressed="${on}" aria-label="Toggle ${esc(store.name)}"></button>
      <span style="grid-column:1/-1">${esc(desc)}</span>
      <span style="grid-column:1/-1;color:var(--mute);font-size:12px">${esc(status)}</span>
    </div>`;
  };

  const hiddenStores = Object.entries(enabledStores)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  const hiddenSection = hiddenStores.length > 0
    ? `<h2>Hidden stores</h2>` +
      hiddenStores.map((k) => {
        const store = STORE_CATALOG.find((s) => s.id === k);
        const name = store ? store.name : k;
        return `<div class="src"><div><b>${esc(name)}</b></div>
          <button class="btn o" data-restore="${esc(k)}">Add back</button>
          <span style="grid-column:1/-1">This store is hidden. Click "Add back" to re-enable it.</span>
        </div>`;
      }).join("")
    : "";

  const tg = (key, n, d, v) => `<div class="src"><div><b>${n}</b></div><button class="tg ${v ? "on" : ""}" data-setting="${key}" aria-pressed="${v}" aria-label="${n}"></button><span style="grid-column:1/-1">${d}</span></div>`;

  scrollEl.innerHTML = `<div class="sec">
    <h2>Stores &amp; launchers</h2>
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap"><span style="color:var(--mute)">${games.length} games across ${STORE_CATALOG.filter((s) => enabledStores[s.id] !== false).length} enabled launchers</span><button class="btn" id="rescan">Rescan now</button></div>
    ${STORE_CATALOG.map(srcRow).join("")}
    ${hiddenSection}
    <h2>Behavior</h2>
    ${tg("scan_on_startup", "Scan on startup", "Uses the saved library first, then refreshes in the background.", settings.scan_on_startup)}
    ${tg("show_stores_in_sidebar", "Show stores in the sidebar", "Lists stores with games under a Stores heading. Turn off for a shorter sidebar.", settings.show_stores_in_sidebar !== false)}
    ${tg("keep_in_tray", "Keep running in the tray", "Closing the window doesn't quit Cabinet.", settings.keep_in_tray)}
    ${tg("hide_removed", "Hide games I've removed", "Trims uninstalled titles from store and collection views. They always stay visible under Uninstalled.", settings.hide_removed)}
    <h2>Artwork</h2>
    <div class="src"><div><b>SteamGridDB API key</b></div><span></span>
      <label class="fld" style="grid-column:1/-1;margin-top:4px">Optional — finds cover art for games that aren't on Steam. The key is stored on this PC and only sent to SteamGridDB.
        <div class="in"><input id="sgdb-key" type="password" autocomplete="off" spellcheck="false" placeholder="Paste your key" value="${esc(settings.sgdb_key || "")}"><button class="btn" id="sgdb-save">Save</button></div>
      </label>
      <span style="grid-column:1/-1;color:var(--mute);font-size:12px">Get a free key at steamgriddb.com → Preferences → API. <a href="#" id="sgdb-link">Open the page</a></span>
    </div>
  </div>`;

  const rb = $("#rescan");
  if (rb) rb.onclick = () => scanGames();

  const sgdbSave = $("#sgdb-save");
  if (sgdbSave) sgdbSave.onclick = () => {
    const key = ($("#sgdb-key")?.value || "").trim();
    if (key === (settings.sgdb_key || "")) { toast("Key unchanged"); return; }
    settings.sgdb_key = key;
    saveSettings();
    // Re-check every automatic cover: SteamGridDB may beat a miss or a loose Steam guess.
    forgetAutoCovers();
    toast(key ? "SteamGridDB key saved — re-checking artwork" : "SteamGridDB key removed");
    renderAll();
  };
  const sgdbLink = $("#sgdb-link");
  if (sgdbLink) sgdbLink.onclick = (e) => {
    e.preventDefault();
    openExternal("https://www.steamgriddb.com/profile/preferences/api");
  };

  document.querySelectorAll("[data-store]").forEach((el) => {
    el.addEventListener("click", () => {
      const key = el.dataset.store;
      const current = storeConfig.stores[key] !== false;
      storeConfig.stores[key] = !current;
      renderSettings();
      renderRail();
      toast(current ? `${key} hidden` : `${key} enabled`);
      // Save first so the scan reads the new config, then refresh the library.
      saveStoreConfig().then(() => scanGames({ quiet: true }));
    });
  });

  document.querySelectorAll("[data-restore]").forEach((el) => {
    el.addEventListener("click", () => {
      const key = el.dataset.restore;
      storeConfig.stores[key] = true;
      renderSettings();
      renderRail();
      toast(`${key} re-enabled`);
      saveStoreConfig().then(() => scanGames({ quiet: true }));
    });
  });
}

function renderAll() {
  renderRail();
  if (currentPage === "lib") renderLibrary();
  else renderSettings();
}

// ── Details panel ────────────────────────────────────────────────────────────
function openPanel(game) {
  selectedGame = game;
  const isFav = favorites.has(game.id);
  const hidden = hiddenGames.has(game.id);
  const status = gameStatuses[game.id] || "playing";
  const loc = game.install_path || "—";

  panelEl.innerHTML = `<button class="x" id="px" aria-label="Close">&times;</button>
    ${renderCover(game)}
    <h2>${esc(game.name)}</h2>
    <p>${esc(sourceName(game))}${game.description ? " — " + esc(game.description) : ""}${hidden ? " · hidden" : ""}</p>
    <div class="acts">
      <button class="btn" data-play="${esc(game.id)}">Play</button>
      <button class="btn o" id="fv">${isFav ? "Remove favorite" : "Favorite"}</button>
      <button class="btn o" id="pcov">Change cover</button>
      <button class="btn o" id="phide">${hidden ? "Unhide" : "Hide"}</button>
    </div>
    <dl>
      <dt>Status</dt><dd><div class="seg" id="st">
        <button class="${status === "backlog" ? "on" : ""}" data-st="backlog">Backlog</button>
        <button class="${status === "playing" ? "on" : ""}" data-st="playing">Playing</button>
        <button class="${status === "finished" ? "on" : ""}" data-st="finished">Finished</button>
      </div></dd>
      <dt>Last played</dt><dd>${relativeTime(lastPlayed(game))}</dd>
      <dt>Install size</dt><dd data-size="${esc(game.id)}">${esc(sizeLabel(game))}</dd>
      <dt>Location</dt><dd style="word-break:break-all">${esc(loc)}</dd>
    </dl>`;
  panelEl.classList.add("on");
  scrimEl.classList.add("on");
  requestSize(game);
}

function closePanel() {
  panelEl.classList.remove("on");
  scrimEl.classList.remove("on");
  dlgEl.classList.remove("on");
  covDlgEl.classList.remove("on");
  selectedGame = null;
}

// ── Add game dialog ──────────────────────────────────────────────────────────
let dlgCover = "";      // artwork URL picked (or typed) in the add dialog
let dlgArtTimer = null;

function openDialog() {
  dlgCover = "";
  const art = $("#dlg-art");
  if (art) art.value = "";
  const sug = $("#dlg-sug");
  if (sug) sug.innerHTML = "";
  dlgEl.classList.add("on");
  scrimEl.classList.add("on");
}

function closeDialog() {
  dlgEl.classList.remove("on");
  if (!panelEl.classList.contains("on")) scrimEl.classList.remove("on");
  dlgCover = "";
  clearTimeout(dlgArtTimer);
  const sug = $("#dlg-sug");
  if (sug) sug.innerHTML = "";
}

// Look up artwork suggestions on Steam for whatever name is typed.
async function suggestArtwork() {
  const box = $("#dlg-sug");
  if (!box) return;
  const name = ($("#dlg-name")?.value || "").trim();
  if (name.length < 3) { box.innerHTML = ""; return; }
  if (!isTauri) {
    box.innerHTML = `<span class="sug-msg">Artwork search needs the desktop app — paste an image URL instead.</span>`;
    return;
  }
  box.innerHTML = `<span class="sug-msg">Searching for artwork…</span>`;
  const { results, error } = await searchArtwork(name);
  if (!results.length) {
    box.innerHTML = `<span class="sug-msg">${artworkEmptyMessage(error)}</span>`;
    return;
  }
  box.innerHTML = results.map((r) => `
    <button type="button" class="sc ${dlgCover === r.cover ? "on" : ""}" data-art="${esc(r.cover)}" title="${esc(r.name)}">
      <img src="${esc(r.cover)}" alt="${esc(r.name)}" loading="lazy">
      <span>${esc(r.name)}</span>
    </button>`).join("");
}

function addGameFromDialog() {
  const exe = $("#dlg-exe").value.trim();
  const name = $("#dlg-name").value.trim();
  const args = $("#dlg-args").value.trim();
  const art = ($("#dlg-art")?.value || "").trim();
  if (!exe || !name) { toast("Please fill in executable and name"); return; }
  const game = {
    id: "custom-" + Date.now(),
    name,
    description: null,
    install_path: exe.replace(/[^\\/]+$/, ""),
    executable_path: exe,
    launch_command: args ? exe + " " + args : exe,
    cover_image_path: art || null,
    source: "Custom",
    last_played: null,
    total_playtime_seconds: 0,
    is_installed: true,
  };
  customGames.push(game);
  saveCustomGames();
  closeDialog();
  toast("Added " + name);
  renderAll();
}

function removeCustomGame(game) {
  if (!confirm(`Remove "${game.name}" from your library?`)) return;
  customGames = customGames.filter((g) => g.id !== game.id);
  saveCustomGames();
  toast("Removed " + game.name);
  renderAll();
}

// ── Per-game three-dot menu ──────────────────────────────────────────────────
function openGameMenu(game, anchor) {
  menuGame = game;
  const isFav = favorites.has(game.id);
  const hidden = hiddenGames.has(game.id);
  const isLocal = game.source === "Custom";
  menuEl.innerHTML = `
    <button data-mi="play">Play</button>
    <button data-mi="favorite">${isFav ? "Remove from favorites" : "Add to favorites"}</button>
    <button data-mi="cover">Set cover image</button>
    <button data-mi="hide">${hidden ? "Unhide game" : "Hide game"}</button>
    <button data-mi="folder">Open install folder</button>
    <button data-mi="details">View details</button>
    ${isLocal ? `<button data-mi="remove" class="danger">Remove from library</button>` : ""}
  `;
  menuEl.style.left = "-9999px";
  menuEl.style.top = "0px";
  menuEl.classList.add("on");
  const r = anchor.getBoundingClientRect();
  const mw = menuEl.offsetWidth;
  const mh = menuEl.offsetHeight;
  let x = r.right - mw;
  let y = r.bottom + 6;
  if (x < 8) x = 8;
  if (x + mw > window.innerWidth - 8) x = window.innerWidth - mw - 8;
  if (y + mh > window.innerHeight - 8) y = r.top - mh - 6;
  if (y < 8) y = 8;
  menuEl.style.left = x + "px";
  menuEl.style.top = y + "px";
}

function closeMenu() {
  menuEl.classList.remove("on");
  menuGame = null;
}

function handleMenuAction(action, game) {
  switch (action) {
    case "play": launchGame(game); break;
    case "favorite": toggleFavorite(game.id); break;
    case "cover": openCoverDialog(game); break;
    case "hide": toggleHidden(game.id); break;
    case "folder": openGameFolder(game); break;
    case "details": openPanel(game); break;
    case "remove": removeCustomGame(game); break;
  }
}

function toggleHidden(id) {
  const nowHidden = !hiddenGames.has(id);
  if (nowHidden) hiddenGames.add(id); else hiddenGames.delete(id);
  saveHiddenGames();
  toast(nowHidden ? "Game hidden (find it under Hidden)" : "Game unhidden");
  renderAll();
}

// ── Cover art dialog ─────────────────────────────────────────────────────────
function openCoverDialog(game) {
  coverGame = game;
  coverPending = { value: null };
  const cur = coverOverrides.get(game.id) || "";
  $("#cov-url").value = /^https?:/i.test(cur) ? cur : "";
  const box = $("#cov-sug");
  if (box) box.innerHTML = "";
  renderCoverPreview();
  covDlgEl.classList.add("on");
  scrimEl.classList.add("on");
}

function closeCoverDialog() {
  covDlgEl.classList.remove("on");
  if (!panelEl.classList.contains("on") && !dlgEl.classList.contains("on")) scrimEl.classList.remove("on");
  coverGame = null;
  coverPending = { value: null };
}

function renderCoverPreview() {
  if (!coverGame) return;
  const typed = ($("#cov-url")?.value || "").trim();
  const v = coverPending.value || typed || coverOverrides.get(coverGame.id) || coverGame.cover_image_path || "";
  const box = $("#cov-prev");
  if (v) {
    box.innerHTML = `<img src="${esc(v)}" alt="" onerror="this.style.opacity=0.12">`;
  } else {
    const { background, color } = getCoverGradient(coverGame.name);
    box.innerHTML = `<div class="cv" style="background:${background};color:${color}"><span class="nm">${esc(coverGame.name)}</span></div>`;
  }
}

function fileToCoverDataUrl(file, maxW = 600, maxH = 900) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        try {
          let w = img.width, h = img.height;
          const scale = Math.min(1, maxW / w, maxH / h);
          w = Math.max(1, Math.round(w * scale));
          h = Math.max(1, Math.round(h * scale));
          const c = document.createElement("canvas");
          c.width = w;
          c.height = h;
          const ctx = c.getContext("2d");
          ctx.drawImage(img, 0, 0, w, h);
          const type = /png/i.test(file.type) ? "image/png" : "image/jpeg";
          resolve(c.toDataURL(type, 0.85));
        } catch {
          resolve(reader.result);
        }
      };
      img.onerror = () => resolve(reader.result);
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function saveCover() {
  if (!coverGame) return;
  const typed = ($("#cov-url").value || "").trim();
  const value = coverPending.value || typed || "";
  if (!value) { toast("Choose a file or paste an image URL"); return; }
  const id = coverGame.id;
  setCoverOverride(id, value);
  closeCoverDialog();
  toast("Cover updated");
  renderAll();
  if (selectedGame && selectedGame.id === id) openPanel(selectedGame);
}

function resetCover() {
  if (!coverGame) return;
  clearCoverOverride(coverGame.id);
  coverPending = { value: null };
  $("#cov-url").value = "";
  renderCoverPreview();
  toast("Cover reset to default");
}

function searchCoverFor(game) {
  if (!game) return;
  const q = encodeURIComponent(`${game.name} cover art`);
  openExternal(`https://www.google.com/search?tbm=isch&q=${q}`);
}

// Offer Steam cover art suggestions for the game being edited.
// What to say when an artwork search comes back empty.
function artworkEmptyMessage(error) {
  if (error && /api key/i.test(error)) {
    return "SteamGridDB rejected your API key — check it in Sources &amp; settings.";
  }
  if (error) return "Artwork search failed — paste an image URL instead.";
  if (!(settings.sgdb_key || "").trim()) {
    return "No matching artwork on Steam. Add a free SteamGridDB key in Sources &amp; settings to search more games, or paste an image URL.";
  }
  return "No matching artwork found — paste an image URL instead.";
}

async function suggestCoverForCurrent() {
  if (!coverGame) return;
  const box = $("#cov-sug");
  if (!box) return;
  if (!isTauri) {
    box.innerHTML = `<span class="sug-msg">Artwork search needs the desktop app — paste an image URL instead.</span>`;
    return;
  }
  box.innerHTML = `<span class="sug-msg">Searching for artwork…</span>`;
  const { results, error } = await searchArtwork(coverGame.name);
  if (!results.length) {
    box.innerHTML = `<span class="sug-msg">${artworkEmptyMessage(error)}</span>`;
    return;
  }
  box.innerHTML = results.map((r) => `
    <button type="button" class="sc" data-covart="${esc(r.cover)}" title="${esc(r.name)}">
      <img src="${esc(r.cover)}" alt="${esc(r.name)}" loading="lazy">
      <span>${esc(r.name)}</span>
    </button>`).join("");
}

// ── Controller mode ──────────────────────────────────────────────────────────
// Games in controller mode: everything except games the user has hidden.
function padGames() {
  return getDisplayGames("all");
}

function openPad() {
  const games = padGames();
  if (!games.length) { toast("No games to display"); return; }
  controllerIndex = 0;
  padEl.classList.add("on");
  renderPad();
  startGamepadLoop();
}

function closePad() {
  padEl.classList.remove("on");
  stopGamepadLoop();
}

function padMove(delta) {
  const n = padGames().length;
  const next = Math.max(0, Math.min(n - 1, controllerIndex + delta));
  if (next !== controllerIndex) { controllerIndex = next; renderPad(); }
}
function padPlay() {
  const g = padGames()[controllerIndex];
  if (g) launchGame(g);
}
function padFavorite() {
  const g = padGames()[controllerIndex];
  if (g) toggleFavorite(g.id).then(renderPad);
}

function renderPad() {
  const games = padGames();
  if (!games.length) { closePad(); return; }
  controllerIndex = Math.min(controllerIndex, games.length - 1);
  const g = games[controllerIndex];
  $("#prow").innerHTML = games.map((game, i) =>
    `<div class="it ${i === controllerIndex ? "f" : ""}">${renderCover(game)}</div>`
  ).join("");
  $("#pinfo").innerHTML = `<h2>${esc(g.name)}</h2><p>${esc(sourceName(g))} · last played ${relativeTime(lastPlayed(g)).toLowerCase()}</p>`;
  $("#pc").textContent = (controllerIndex + 1) + " of " + games.length;
  const f = $("#prow .f");
  if (f) f.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
}

// ── Gamepad (controller mode) ────────────────────────────────────────────────
// Standard mapping: 0 = A (play), 1 = B (back), 3 = Y (favorite),
// 14/15 = d-pad left/right, axis 0 = left stick. Polled only while the overlay is
// open. Note: WebView2/Chromium hides gamepads until a button is pressed after
// the page loads, so the very first press may only "wake" the controller.
let padRaf = 0;
let padPrev = [];       // button states from the previous frame (edge detection)
let padHeldDir = 0;     // -1 / 0 / 1 direction currently held
let padRepeatAt = 0;    // when a held direction may step again

function firstGamepad() {
  if (!navigator.getGamepads) return null;
  return [...navigator.getGamepads()].find((g) => g && g.connected) || null;
}

function startGamepadLoop() {
  if (padRaf) return;
  // Treat buttons already held when the overlay opens as "not new".
  const gp = firstGamepad();
  padPrev = gp ? gp.buttons.map((b) => b.pressed) : [];
  padHeldDir = 0;
  padRaf = requestAnimationFrame(pollGamepad);
}

function stopGamepadLoop() {
  if (padRaf) cancelAnimationFrame(padRaf);
  padRaf = 0;
  padPrev = [];
  padHeldDir = 0;
}

function pollGamepad(now) {
  padRaf = 0;
  if (!padEl.classList.contains("on")) return;
  const gp = firstGamepad();
  if (gp) {
    const pressed = gp.buttons.map((b) => b.pressed);
    const justPressed = (i) => pressed[i] && !padPrev[i];
    padPrev = pressed;

    if (justPressed(1)) { closePad(); return; }
    if (justPressed(0)) padPlay();
    else if (justPressed(3)) padFavorite();

    // Left/right from the d-pad or stick; repeats while held, like a key.
    const x = gp.axes[0] || 0;
    const dir = (pressed[15] || x > 0.5) ? 1 : (pressed[14] || x < -0.5) ? -1 : 0;
    if (dir !== padHeldDir) {
      padHeldDir = dir;
      if (dir) { padMove(dir); padRepeatAt = now + 400; }
    } else if (dir && now >= padRepeatAt) {
      padMove(dir);
      padRepeatAt = now + 120;
    }
  }
  padRaf = requestAnimationFrame(pollGamepad);
}

// While a controller is connected and the overlay is closed, a light watcher
// (not a per-frame loop) lets Start (button 9) open controller mode.
let startWatchTimer = 0;
let startPrev = false;

function watchStartButton() {
  if (startWatchTimer) return;
  startPrev = true;   // ignore a Start already held when watching begins
  startWatchTimer = setInterval(() => {
    const gp = firstGamepad();
    const pressed = !!(gp && gp.buttons[9] && gp.buttons[9].pressed);
    const justPressed = pressed && !startPrev;
    startPrev = pressed;
    // The overlay's own loop owns input while it's open; skip when hidden/in tray.
    if (justPressed && !document.hidden && !padEl.classList.contains("on")) openPad();
  }, 150);
}

function stopWatchingStartButton() {
  clearInterval(startWatchTimer);
  startWatchTimer = 0;
}

function setupGamepadWatcher() {
  window.addEventListener("gamepadconnected", watchStartButton);
  window.addEventListener("gamepaddisconnected", () => {
    if (!firstGamepad()) stopWatchingStartButton();
  });
  if (firstGamepad()) watchStartButton();   // already exposed before we listened
}

// ── Toast ────────────────────────────────────────────────────────────────────
function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1800);
}

// ── Events ───────────────────────────────────────────────────────────────────
function setupEventListeners() {
  document.addEventListener("click", (e) => {
    // Three-dot menu button
    const menuBtn = e.target.closest("[data-menu]");
    if (menuBtn) {
      e.stopPropagation();
      const game = baseGames().find((g) => g.id === menuBtn.dataset.menu);
      if (game) openGameMenu(game, menuBtn);
      return;
    }

    // Menu item
    const mi = e.target.closest("[data-mi]");
    if (mi && menuGame) {
      const game = menuGame;
      const action = mi.dataset.mi;
      closeMenu();
      handleMenuAction(action, game);
      return;
    }

    // Any other click dismisses an open menu
    if (menuEl.classList.contains("on")) closeMenu();

    // Play buttons
    const playBtn = e.target.closest("[data-play]");
    if (playBtn) {
      e.stopPropagation();
      const game = baseGames().find((g) => g.id === playBtn.dataset.play);
      if (game) launchGame(game);
      return;
    }

    // Sidebar nav
    const ri = e.target.closest(".ri");
    if (ri) {
      if (ri.dataset.pad !== undefined) { openPad(); return; }
      if (ri.dataset.pg) { currentPage = "set"; }
      else { currentPage = "lib"; currentFilter = ri.dataset.f; searchQuery = ""; }
      renderAll();
      return;
    }

    // View toggle
    const v = e.target.closest("[data-v]");
    if (v) { currentView = v.dataset.v; renderLibrary(); return; }

    // Game card / row click
    const card = e.target.closest("[data-id]");
    if (card) {
      const game = baseGames().find((g) => g.id === card.dataset.id);
      if (game) openPanel(game);
      return;
    }

    // Close overlays
    if (e.target.closest("#px") || e.target.id === "scrim" || e.target.id === "dx" || e.target.id === "cov-x") {
      closePanel();
      return;
    }

    // Add game
    if (e.target.id === "add") { openDialog(); return; }
    if (e.target.id === "dok") { addGameFromDialog(); return; }
    if (e.target.id === "dlg-browse") { $("#dlg-file").click(); return; }
    if (e.target.id === "dlg-find") { suggestArtwork(); return; }

    // Artwork suggestion pick
    const art = e.target.closest("[data-art]");
    if (art) {
      dlgCover = art.dataset.art;
      const field = $("#dlg-art");
      if (field) field.value = dlgCover;
      document.querySelectorAll("#dlg-sug .sc").forEach((b) => b.classList.toggle("on", b === art));
      return;
    }

    // Panel actions
    if (e.target.id === "fv" && selectedGame) { toggleFavorite(selectedGame.id); openPanel(selectedGame); return; }
    if (e.target.id === "pcov" && selectedGame) { openCoverDialog(selectedGame); return; }
    if (e.target.id === "phide" && selectedGame) { toggleHidden(selectedGame.id); openPanel(selectedGame); return; }

    // Cover dialog actions
    if (e.target.id === "cov-file") { $("#cov-input").click(); return; }
    if (e.target.id === "cov-search") { searchCoverFor(coverGame); return; }
    if (e.target.id === "cov-find") { suggestCoverForCurrent(); return; }
    if (e.target.id === "cov-reset") { resetCover(); return; }
    if (e.target.id === "cov-save") { saveCover(); return; }

    // Cover dialog suggestion pick
    const covart = e.target.closest("[data-covart]");
    if (covart) {
      coverPending = { value: null };
      $("#cov-url").value = covart.dataset.covart;
      document.querySelectorAll("#cov-sug .sc").forEach((b) => b.classList.toggle("on", b === covart));
      renderCoverPreview();
      return;
    }

    // Status segmented control
    const sg = e.target.closest("#st button");
    if (sg && selectedGame) {
      gameStatuses[selectedGame.id] = sg.dataset.st;
      saveGameStatuses();
      openPanel(selectedGame);
      return;
    }

    // Behavior setting toggles (store toggles have their own listener)
    const tg = e.target.closest(".tg");
    if (tg) {
      if (tg.dataset.store) return;
      const key = tg.dataset.setting;
      if (!key) return;
      settings[key] = !(tg.getAttribute("aria-pressed") === "true");
      saveSettings();
      if (key === "keep_in_tray") syncTraySetting();
      renderAll();
      return;
    }
  });

  // Add-game browse input
  const fileInput = $("#dlg-file");
  if (fileInput) {
    fileInput.addEventListener("change", (e) => {
      const f = e.target.files[0];
      if (f) $("#dlg-exe").value = f.path || f.name;
    });
  }

  // Add-game: suggest artwork as the user types the name
  const nameInput = $("#dlg-name");
  if (nameInput) {
    nameInput.addEventListener("input", () => {
      clearTimeout(dlgArtTimer);
      dlgArtTimer = setTimeout(suggestArtwork, 700);
    });
  }

  // Add-game: typing a URL clears any picked suggestion
  const artInput = $("#dlg-art");
  if (artInput) {
    artInput.addEventListener("input", () => {
      if (artInput.value.trim() !== dlgCover) {
        dlgCover = "";
        document.querySelectorAll("#dlg-sug .sc").forEach((b) => b.classList.remove("on"));
      }
    });
  }

  // Cover image file input
  const covInput = $("#cov-input");
  if (covInput) {
    covInput.addEventListener("change", async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        coverPending.value = await fileToCoverDataUrl(f);
        const cu = $("#cov-url");
        if (cu) cu.value = "";
        renderCoverPreview();
      } catch {
        toast("Couldn't read that image");
      }
      covInput.value = "";
    });
  }

  // Cover URL live preview
  const covUrl = $("#cov-url");
  if (covUrl) {
    covUrl.addEventListener("input", () => {
      coverPending = { value: null };
      renderCoverPreview();
    });
  }

  // Keyboard
  document.addEventListener("keydown", (e) => {
    if (padEl.classList.contains("on")) {
      const key = e.key.toLowerCase();
      if (e.key === "ArrowRight") padMove(1);
      else if (e.key === "ArrowLeft") padMove(-1);
      else if (e.key === "Enter" || key === "a") padPlay();
      else if (key === "y") padFavorite();
      else if (e.key === "Escape" || key === "b") closePad();
      e.preventDefault();
    } else if (e.key === "Escape") {
      if (menuEl.classList.contains("on")) { closeMenu(); return; }
      closePanel();
    }
  });

  // Dismiss the menu on scroll / resize
  scrollEl.addEventListener("scroll", () => { if (menuEl.classList.contains("on")) closeMenu(); }, true);
  window.addEventListener("resize", () => { if (menuEl.classList.contains("on")) closeMenu(); });
}

// ── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  loadSettings();
  loadCustomGames();
  loadGameStatuses();
  loadLastLaunched();
  loadSavedSizes();
  loadHiddenGames();
  loadCoverLookup();
  setupEventListeners();
  setupGamepadWatcher();
  syncTraySetting();
  await loadCoverOverrides();
  await loadFavorites();
  await loadCachedGames();
  await loadStoreConfig();
  await loadDetectedStores();
  renderAll();
  // Show the saved library first; refresh it in the background if enabled.
  // With nothing saved yet there is nothing to show, so always scan then.
  if (isTauri && (settings.scan_on_startup || allGames.length === 0)) {
    await scanGames({ quiet: true });
  }
}

init();
