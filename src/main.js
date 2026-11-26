import { invoke } from "@tauri-apps/api/core";
import "@fontsource/schibsted-grotesk/400.css";
import "@fontsource/schibsted-grotesk/500.css";
import "@fontsource/schibsted-grotesk/600.css";
import "@fontsource/schibsted-grotesk/800.css";

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
let currentPage = "lib"; // "lib" | "trend" | "set"
let controllerIndex = 0;
let gameStatuses = {}; // game_id → "backlog" | "playing" | "finished"
let lastLaunched = {}; // game_id → ISO time of the last launch from Game Console Alpha
let menuGame = null;   // game whose three-dot menu is open
let coverGame = null;  // game whose cover dialog is open
let coverPending = { value: null }; // staged cover (data URL) from a picked file
let settings = {
  scan_on_startup: true,
  keep_in_tray: false,
  hide_removed: false,
  show_stores_in_sidebar: true,
  show_owned_games: true, // list owned-but-not-installed games on a store's page
  sgdb_key: "",   // SteamGridDB API key (optional) for artwork of non-Steam games
};
let storeConfig = {
  stores: { steam: true, epic: true, gog: true },
};
let detectedStores = []; // [{ id, name, path, installed }] from the backend

// Game folders: folders the user keeps games in. New subfolders are offered as games.
let gameFolders = { folders: [], check_periodically: true }; // from the backend
let foundGames = [];              // [{ folder, parent, title, exes }] not answered yet
let foundShown = [];              // the games in the open "new games" dialog
const snoozedFolders = new Set(); // "Not now": don't offer again until next launch
const FOLDER_CHECK_MS = 30 * 60 * 1000;

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

// Games owned in a store (Steam, Epic) but not installed, and their installs. Owned games are
// kept apart from allGames: `is_installed: false` there means "removed".
let ownedGames = [];                 // from get_store_library, each tagged owned: true
const installStatus = new Map();     // app_id → latest status from the backend
const installWatch = new Map();      // app_id → { since, baseline } installs being followed
const shownProgress = new Map();     // app_id → highest progress shown, so bars never go back

// ── DOM refs ─────────────────────────────────────────────────────────────────
const $ = (s) => document.querySelector(s);
const railEl = $("#rail");
const topEl = $("#top");
const scrollEl = $("#sc");
const scrimEl = $("#scrim");
const panelEl = $("#panel");
const dlgEl = $("#dlg");
const covDlgEl = $("#covdlg");
const fndEl = $("#fnd");
const foundBarEl = $("#found");
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
  // Cover-dialog preview: keep the broken image faintly visible as feedback.
  if (img.hasAttribute("data-dim-on-error")) { img.style.opacity = "0.12"; return; }
  const fb = (img.dataset.fb || "").split("|").filter(Boolean);
  if (fb.length) {
    img.dataset.fb = fb.slice(1).join("|");
    img.src = fb[0];
  } else {
    // No art at all: on a cover, show the generated tile with the title so the
    // card isn't blank (thumbnails already have their gradient behind).
    const cover = img.parentElement;
    const name = img.alt;
    img.remove();
    if (cover && cover.classList.contains("cv") && name && !cover.querySelector(".nm")) {
      const { background, color } = getCoverGradient(name);
      cover.style.background = background;
      cover.style.color = color;
      const label = document.createElement("span");
      label.className = "nm";
      label.textContent = name;
      cover.prepend(label);
    }
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

// Any game by id, including owned games that aren't installed.
function findGame(id) {
  return baseGames().find((g) => g.id === id) || ownedGames.find((g) => g.id === id);
}

// Owned-but-not-installed games that belong in a view: a store's own page
// (when the setting is on) and the Hidden collection — never "All games",
// favorites or the other collections.
function ownedGamesFor(filter) {
  if (!ownedGames.length) return [];
  const installed = new Set(baseGames().map((g) => g.id));
  const notInstalled = ownedGames.filter((g) => !installed.has(g.id));
  if (filter === "hidden") return notInstalled.filter((g) => hiddenGames.has(g.id));
  if (!settings.show_owned_games) return [];
  return notInstalled.filter((g) => g.source === filter && !hiddenGames.has(g.id));
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
// from Game Console Alpha, whichever is newer. Epic, GOG and local games only have the latter.
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
  games = games.concat(ownedGamesFor(currentFilter));
  if (searchQuery) {
    games = games.filter((g) => g.name.toLowerCase().includes(searchQuery));
  }
  if (sortBy === "az") games.sort((a, b) => a.name.localeCompare(b.name));
  else if (sortBy === "recent") games.sort((a, b) => {
    // Installed games first; owned-only ones follow, A to Z.
    if (!!a.owned !== !!b.owned) return a.owned ? 1 : -1;
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
    await loadOwnedGames();
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

// ── Owned games: install from the store, follow progress ────────────────────
// Stores that can list owned games and install them (backend store ids).
const OWNED_STORES = ["steam", "epic"];

function storeLabel(store) {
  const s = STORE_CATALOG.find((x) => x.id === store);
  return s ? s.name : store;
}

async function loadOwnedGames() {
  if (!isTauri) { ownedGames = []; return; }
  const lists = await Promise.all(OWNED_STORES.map(async (store) => {
    if (storeConfig.stores[store] === false) return [];
    try {
      const list = await invoke("get_store_library", { store });
      return Array.isArray(list) ? list : [];
    } catch (e) {
      console.error(`Couldn't read the ${storeLabel(store)} library:`, e);
      return ownedGames.filter((g) => g.store === store); // keep what we had
    }
  }));
  ownedGames = lists.flat().map((g) => ({ ...g, owned: true }));
}

async function installOwnedGame(game) {
  if (!isTauri) { toast("Installing needs the desktop app"); return; }
  const label = storeLabel(game.store);
  try {
    await invoke("install_store_game", { store: game.store, appId: game.app_id });
    // An old failure in the store's log isn't news; only a new one is.
    const cur = installStatus.get(game.app_id);
    installWatch.set(game.app_id, {
      since: Date.now(),
      store: game.store,
      baseline: cur && cur.state === "failed" ? cur.message : null,
    });
    toast(`Confirm the install in ${label}`);
    refreshInstallViews(game.app_id);
    scheduleInstallPoll(1500);
  } catch (e) {
    toast(typeof e === "string" ? e : `Couldn't open ${label}`);
  }
}

const ACTIVE_INSTALL = new Set(["queued", "preparing", "downloading", "verifying", "installing", "paused"]);

function formatRate(bps) {
  return bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} MB/s` : `${Math.max(1, Math.round(bps / 1e3))} KB/s`;
}

// What to show for an owned game's install, or null when nothing is going on.
// busy hides the Install button; pct/indeterminate drive the progress bar.
function installInfo(g) {
  const st = installStatus.get(g.app_id);
  const w = installWatch.get(g.app_id);
  const state = st ? st.state : "none";
  const label = storeLabel(g.store);
  if (state === "failed" && w && st.message !== w.baseline) {
    return { text: "Install failed", title: st.message, busy: false };
  }
  if (!ACTIVE_INSTALL.has(state)) {
    if (!w) return null;
    const text = state === "installed" ? "Finishing up…" : `Waiting for ${label}…`;
    return { text, busy: true, indeterminate: true };
  }
  const p = Math.max(shownProgress.get(g.app_id) || 0, st.progress || 0);
  const pct = st.progress == null && !shownProgress.has(g.app_id) ? null : Math.floor(p * 100);
  switch (state) {
    case "downloading":
      return {
        text: `Downloading${pct != null ? ` ${pct}%` : ""}${st.rate ? ` · ${formatRate(st.rate)}` : ""}`,
        pct, busy: true, indeterminate: pct == null,
      };
    case "paused":
      return { text: `Paused${pct != null ? ` at ${pct}%` : ""} in ${label}`, pct, busy: false };
    case "queued": return { text: `Queued in ${label}`, pct, busy: true };
    case "verifying": return { text: "Verifying files…", busy: true, indeterminate: true };
    case "installing": return { text: "Installing…", busy: true, indeterminate: true };
    default: return { text: "Preparing…", busy: true, indeterminate: true };
  }
}

function installLine(g) {
  const info = installInfo(g);
  if (!info) return `${esc(sourceName(g))} · Not installed`;
  const title = info.title ? ` title="${esc(info.title)}"` : "";
  const bar = info.indeterminate
    ? `<i class="ibar ind"><i></i></i>`
    : info.pct != null ? `<i class="ibar"><i style="width:${info.pct}%"></i></i>` : "";
  return `<em class="ist"${title}>${esc(info.text)}</em>${bar}`;
}

function installBusy(g) {
  const info = installInfo(g);
  return !!(info && info.busy);
}

// Update an owned game's status everywhere it's shown, without re-rendering
// the grid (which would restart image loads every couple of seconds).
function refreshInstallViews(appId) {
  const g = ownedGames.find((x) => x.app_id === appId);
  if (!g) return;
  const sel = CSS.escape(g.id);
  const busy = installBusy(g);
  document.querySelectorAll(`[data-inst="${sel}"]`).forEach((el) => { el.innerHTML = installLine(g); });
  document.querySelectorAll(`[data-own="${sel}"]`).forEach((el) => el.classList.toggle("busy", busy));
}

// Poll install status while an install is being followed. While a store's
// page is open, also look every 30 s for installs started in the store itself.
let installTimer = 0;
let lastFullInstallCheck = 0;
let lastFullInstallPage = "";

// The owned games of the store page being viewed, if any.
function ownedPageGames() {
  if (currentPage !== "lib" || !settings.show_owned_games) return [];
  return ownedGamesFor(currentFilter);
}

// Installs that are moving (or that the store hasn't picked up yet after our
// click) are polled every 2 s; paused or queued ones only every 30 s, so an
// old paused download can't keep the app busy for ever.
const MOVING_INSTALL = new Set(["preparing", "downloading", "verifying", "installing"]);

function installMoving() {
  for (const id of installWatch.keys()) {
    const st = installStatus.get(id);
    if (!st || !ACTIVE_INSTALL.has(st.state) || MOVING_INSTALL.has(st.state)) return true;
  }
  return false;
}

function scheduleInstallPoll(delay) {
  clearTimeout(installTimer);
  installTimer = 0;
  if (!isTauri || (!installWatch.size && !ownedPageGames().length)) return;
  installTimer = setTimeout(pollInstalls, delay ?? (installMoving() ? 2000 : 30000));
}

async function pollInstalls() {
  installTimer = 0;
  const byStore = new Map(); // store → Set of app ids
  const add = (store, id) => {
    if (!store) return;
    if (!byStore.has(store)) byStore.set(store, new Set());
    byStore.get(store).add(id);
  };
  for (const [id, w] of installWatch) add(w.store, id);
  const page = ownedPageGames();
  if (page.length && (Date.now() - lastFullInstallCheck > 30000 || lastFullInstallPage !== currentFilter)) {
    lastFullInstallCheck = Date.now();
    lastFullInstallPage = currentFilter;
    page.forEach((g) => add(g.store, g.app_id));
  }
  for (const [store, ids] of byStore) {
    try {
      const statuses = await invoke("store_install_status", { store, appIds: [...ids] });
      await applyInstallStatuses(store, statuses || []);
    } catch (e) {
      console.error("Install status failed:", e);
    }
  }
  scheduleInstallPoll();
}

async function applyInstallStatuses(store, statuses) {
  const finished = [];
  for (const st of statuses) {
    const id = st.app_id;
    installStatus.set(id, st);
    if (ACTIVE_INSTALL.has(st.state)) {
      // Follow downloads started in the store itself, but only once they move.
      if (!installWatch.has(id) && MOVING_INSTALL.has(st.state)) {
        installWatch.set(id, { since: Date.now(), store, baseline: null });
      }
      if (st.progress != null) shownProgress.set(id, Math.max(shownProgress.get(id) || 0, st.progress));
    }
    const w = installWatch.get(id);
    if (w) {
      if (st.state === "installed") finished.push(id);
      // Nothing started within five minutes: the store's dialog was probably
      // cancelled. A new failure stays on screen until then too.
      else if (!ACTIVE_INSTALL.has(st.state) && Date.now() - w.since > 300000) {
        installWatch.delete(id);
        shownProgress.delete(id);
      }
    }
    refreshInstallViews(id);
  }
  if (!finished.length) return;

  for (const id of finished) {
    installWatch.delete(id);
    shownProgress.delete(id);
    const g = ownedGames.find((x) => x.app_id === id);
    toast(`${g ? g.name : "Game"} is installed`);
  }
  // Pick up the new install as a normal, playable game.
  try {
    const games = await invoke("rescan_platform", { platform: store });
    if (Array.isArray(games)) allGames = games;
  } catch (e) {
    console.error("Rescan after install failed:", e);
  }
  await loadOwnedGames();
  renderAll();
}

async function launchGame(game) {
  if (game.owned) { installOwnedGame(game); return; }
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
  const exeDir = (game.executable_path || "").replace(/[\\/][^\\/]*$/, "");
  const path = game.install_path || exeDir;
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
  html += `<h4>Discover</h4>`;
  html += `<button class="ri ${currentPage === "trend" ? "on" : ""}" data-pg="trend">Trending</button>`;
  if (settings.show_stores_in_sidebar !== false) {
    const rows = STORE_CATALOG
      .filter((s) => storeConfig.stores[s.id] !== false)
      .map((s) => ({ s, n: cnt(s.source) }))
      .filter((r) => r.n > 0 || ownedGamesFor(r.s.source).length > 0);
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
    html += `<button class="ri ${currentPage === "lib" && currentFilter === "hidden" ? "on" : ""}" data-f="hidden">Hidden<em>${cnt("hidden") + ownedGamesFor("hidden").length}</em></button>`;
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
  if (currentPage === "trend") {
    topEl.innerHTML = `<h1>Trending</h1><span class="n" id="tcount">${esc(trendTotalText(trendData.get(trendKey())))}</span>
      <input class="q" id="tq" type="search" placeholder="Search Steam" value="${esc(trendInput)}" aria-label="Search the Steam store">`;
    return;
  }
  const titles = { all: "All games", recent: "Recently played", fav: "Favorites", local: "Local Games", uninstalled: "Uninstalled", hidden: "Hidden" };
  const store = STORE_CATALOG.find((x) => x.source === currentFilter);
  const t = titles[currentFilter] || (store ? store.name : currentFilter);
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
    h = `<div class="grid">` + games.map((g) => g.owned ? `
      <button class="g own ${installBusy(g) ? "busy" : ""}" data-id="${esc(g.id)}" data-own="${esc(g.id)}">
        ${renderCover(g, "", `<span class="play" data-install="${esc(g.id)}">Install</span>`)}
        <div class="grow">
          <b>${esc(g.name)}</b>
          <span class="dots" data-menu="${esc(g.id)}" role="button" tabindex="0" aria-label="Options for ${esc(g.name)}">&#8942;</span>
        </div>
        <span data-inst="${esc(g.id)}">${installLine(g)}</span>
      </button>` : `
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
      + games.map((g) => g.owned ? `
        <tr class="own ${installBusy(g) ? "busy" : ""}" data-id="${esc(g.id)}" data-own="${esc(g.id)}">
          <td>${renderThumb(g)}</td>
          <td>${esc(g.name)}</td>
          <td>${esc(sourceName(g))}</td>
          <td class="r">—</td>
          <td data-inst="${esc(g.id)}">${installLine(g)}</td>
          <td class="r"><button class="btn o" data-install="${esc(g.id)}" style="padding:5px 14px">Install</button></td>
          <td class="r"><button class="dots-inline" data-menu="${esc(g.id)}" aria-label="Options for ${esc(g.name)}">&#8942;</button></td>
        </tr>` : `
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
    // Follow installs on a store's page, including ones started in the store.
    if (ownedPageGames().length && !installTimer) scheduleInstallPoll(0);
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

  const gameFolderRows = !isTauri
    ? `<div class="src"><span style="grid-column:1/-1">Game folders need the desktop app.</span></div>`
    : gameFolders.folders.length
      ? gameFolders.folders.map((f) => {
          const status = !f.exists
            ? "Folder not found. Is the drive connected?"
            : f.ignored
              ? `${f.ignored} ignored folder${f.ignored === 1 ? "" : "s"} · <a href="#" data-gf-reset="${esc(f.path)}">Suggest again</a>`
              : "Watching for new games";
          return `<div class="src"><div><b style="word-break:break-all">${esc(f.path)}</b></div>
            <button class="btn o" data-gf-remove="${esc(f.path)}">Remove</button>
            <span style="grid-column:1/-1">${status}</span>
          </div>`;
        }).join("")
      : `<div class="src"><span style="grid-column:1/-1">No game folders yet. Add the folder you install games into, like D:\\Games.</span></div>`;

  const tg = (key, n, d, v) => `<div class="src"><div><b>${n}</b></div><button class="tg ${v ? "on" : ""}" data-setting="${key}" aria-pressed="${v}" aria-label="${n}"></button><span style="grid-column:1/-1">${d}</span></div>`;

  scrollEl.innerHTML = `<div class="sec">
    <h2>Stores &amp; launchers</h2>
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap"><span style="color:var(--mute)">${games.length} games across ${STORE_CATALOG.filter((s) => enabledStores[s.id] !== false).length} enabled launchers</span><button class="btn" id="rescan">Rescan now</button></div>
    ${STORE_CATALOG.map(srcRow).join("")}
    ${hiddenSection}
    <h2>Game folders</h2>
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap"><span style="color:var(--mute)">New games in these folders are offered when the app starts.</span><div style="display:flex;gap:8px"><button class="btn o" id="gf-check">Check now</button><button class="btn" id="gf-add">Add folder</button></div></div>
    ${gameFolderRows}
    <div class="src"><div><b>Check every 30 minutes</b></div><button class="tg ${gameFolders.check_periodically ? "on" : ""}" data-gf-periodic aria-pressed="${!!gameFolders.check_periodically}" aria-label="Check every 30 minutes"></button><span style="grid-column:1/-1">Also checks while Game Console Alpha is open, including in the tray.</span></div>
    <h2>Behavior</h2>
    ${tg("scan_on_startup", "Scan on startup", "Uses the saved library first, then refreshes in the background.", settings.scan_on_startup)}
    ${tg("show_stores_in_sidebar", "Show stores in the sidebar", "Lists stores with games under a Stores heading. Turn off for a shorter sidebar.", settings.show_stores_in_sidebar !== false)}
    ${tg("keep_in_tray", "Keep running in the tray", "Closing the window doesn't quit Game Console Alpha.", settings.keep_in_tray)}
    ${tg("show_owned_games", "Show games I own but haven't installed", "On a store's page, lists the rest of your library with an Install button. Steam and Epic Games.", settings.show_owned_games !== false)}
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
  else if (currentPage === "trend") renderTrending();
  else renderSettings();
}

// ── Trending ─────────────────────────────────────────────────────────────────
// Tabs and search from the Steam store, a page at a time, with the filter
// panel's filters. The backend fetches pages (and caches them for 30 minutes);
// they're kept here too so a re-render never refetches. More pages load as the
// grid scrolls to its end.
const TREND_LISTS = [
  ["top_sellers", "Top sellers"],
  ["new_trending", "New & trending"],
  ["multiplayer", "Multiplayer"],
  ["most_played", "Most played"],
  ["upcoming", "Upcoming"],
];
const TREND_STALE_MS = 30 * 60 * 1000;
// Sorts the store can do; only Search and Multiplayer use them (the ranked
// tabs are their own order).
const TREND_SORT_REST = [["reviews", "Best reviewed"], ["released", "Newest"], ["name", "Name"],
  ["price_asc", "Lowest price"], ["price_desc", "Highest price"]];
const TREND_SORTS = {
  search: [["relevance", "Relevance"], ...TREND_SORT_REST],
  multiplayer: [["top", "Top sellers"], ...TREND_SORT_REST],
};
// Steam store categories (ids from the store's own category list).
const TREND_PLAYERS = [
  [2, "Single-player"], [1, "Multi-player"], [9, "Co-op"], [38, "Online co-op"],
  [49, "PvP"], [36, "Online PvP"], [24, "Split screen"], [39, "Split-screen co-op"],
  [37, "Split-screen PvP"], [48, "LAN co-op"], [47, "LAN PvP"], [20, "MMO"],
  [27, "Cross-platform"], [44, "Remote Play Together"],
];
const TREND_FEATURES = [
  [28, "Full controller support"], [18, "Partial controller support"], [22, "Achievements"],
  [23, "Steam Cloud"], [29, "Trading cards"], [30, "Workshop"], [62, "Family Sharing"],
  [8, "Valve Anti-Cheat"], [17, "Level editor"],
];
// Genre tags shown as one-click chips (matched by name to Steam's tag list).
const TREND_QUICK_TAGS = [
  "Action", "Adventure", "RPG", "Strategy", "Simulation", "Casual", "Indie", "Shooter",
  "FPS", "Open World", "Survival", "Horror", "Puzzle", "Platformer", "Racing", "Sports",
  "Fighting", "Roguelike", "Roguelite", "Souls-like", "Metroidvania", "Sandbox", "Story Rich",
  "Building", "City Builder", "Turn-Based Strategy", "Card Game", "Visual Novel", "Anime",
  "Battle Royale", "Cozy", "Pixel Graphics",
];
const TREND_REVIEW_PCT = [["", "Any rating"], ["70", "70%+ positive"], ["80", "80%+ positive"], ["90", "90%+ positive"], ["95", "95%+ positive"]];
const TREND_REVIEW_COUNT = [["", "Any number of reviews"], ["100", "100+ reviews"], ["1000", "1,000+ reviews"], ["10000", "10,000+ reviews"], ["100000", "100,000+ reviews"]];
const TREND_WITHIN = [["", "Released any time"], ["7", "Past week"], ["30", "Past month"], ["90", "Past 3 months"], ["180", "Past 6 months"], ["365", "Past year"]];
const TREND_FILTERS_KEY = "cabinet_trend_filters";

function emptyTrendFilters() {
  return {
    tags: [], exclude_tags: [], categories: [], os: "", deck: [], vr: false, language: "",
    price: "", max_price: "", on_sale: false, hide_early_access: false,
    min_review_pct: "", min_review_count: "", released_within_days: "", year_min: "", year_max: "",
    hide_library: false,
  };
}

function loadTrendFilters() {
  const f = emptyTrendFilters();
  try {
    const saved = JSON.parse(localStorage.getItem(TREND_FILTERS_KEY) || "null");
    if (saved && typeof saved === "object") {
      for (const k of Object.keys(f)) {
        const v = saved[k];
        if (v === undefined || typeof v !== typeof f[k] || Array.isArray(v) !== Array.isArray(f[k])) continue;
        f[k] = Array.isArray(v) ? v.map(Number).filter(Number.isFinite) : v;
      }
    }
  } catch {}
  return f;
}

let trendList = "top_sellers";
let trendInput = "";          // the search box as typed
let trendQuery = "";          // the search being shown (trimmed)
let trendFilters = loadTrendFilters();
const trendSort = { search: "relevance", multiplayer: "top" };
let trendFiltersOpen = false;
let trendOptions = null;      // { tags: [{id,name}], languages: [{id,name}] } from the store
let trendOptionsLoading = false;
// key → { games, total, next, at, loading, more (loading a further page), error, moreError, emptyRuns }
const trendData = new Map();
let trendSearchTimer = 0;
let trendRefreshTimer = 0;
let trendSelected = null;     // game in the details panel

// Torrent availability for games opened in the Discover details panel:
// app_id → { checking } | { result } | { error }. Checked once per session.
const torrentCache = new Map();

function saveTrendFilters() {
  try { localStorage.setItem(TREND_FILTERS_KEY, JSON.stringify(trendFilters)); } catch {}
}

function trendTab() {
  return trendQuery.length >= 2 ? "search" : trendList;
}

// The filters as the backend takes them, for a tab.
function trendApiFilters(tab) {
  const f = trendFilters;
  const num = (v) => {
    const s = String(v).trim().replace(/[^\d.]/g, "");
    const n = Number(s);
    return s !== "" && Number.isFinite(n) ? n : null;
  };
  const int = (v) => { const n = num(v); return n === null ? null : Math.round(n); };
  // Unreleased games have no reviews or price and haven't come out yet, so
  // these filters would hide the whole Upcoming tab.
  const upcoming = tab === "upcoming";
  return {
    tags: f.tags, exclude_tags: f.exclude_tags, categories: f.categories,
    os: f.os || null, deck: f.deck, vr: f.vr, language: f.language || null,
    price: f.price || null, max_price: upcoming ? null : num(f.max_price), on_sale: f.on_sale,
    hide_early_access: f.hide_early_access,
    min_review_pct: upcoming ? null : int(f.min_review_pct),
    min_review_count: upcoming ? null : int(f.min_review_count),
    released_within_days: upcoming ? null : int(f.released_within_days),
    year_min: int(f.year_min), year_max: int(f.year_max),
    sort: TREND_SORTS[tab] ? trendSort[tab] : null,
  };
}

function trendKey() {
  const tab = trendTab();
  // The query is encoded so a "|" in it can't break the key apart.
  const q = tab === "search" ? encodeURIComponent(trendQuery.toLowerCase()) : "";
  return `${tab}|${q}|${JSON.stringify(trendApiFilters(tab))}`;
}

// How many filters are set (the sort doesn't count).
function trendFilterCount() {
  const f = trendFilters;
  let n = f.tags.length + f.exclude_tags.length + f.categories.length + f.deck.length;
  for (const k of ["os", "language", "price", "max_price", "min_review_pct", "min_review_count", "released_within_days", "year_min", "year_max"]) {
    if (String(f[k]).trim() !== "") n++;
  }
  for (const k of ["vr", "on_sale", "hide_early_access", "hide_library"]) if (f[k]) n++;
  return n;
}

// Fetch the first page of a tab or search (or, with `more`, the next one). A
// slow answer for an older key is stored but only shown if it's still what
// the page is showing.
async function loadTrend(key, more = false) {
  const prev = trendData.get(key);
  if (prev && (prev.loading || prev.more)) return;
  if (more && (!prev || prev.next == null)) return;
  const [tab, q] = key.split("|", 2);
  const filters = JSON.parse(key.slice(tab.length + q.length + 2));
  const query = tab === "search" ? trendQuery.trim() : "";

  if (more) {
    prev.more = true;
    prev.moreError = null;
  } else {
    // Keep the map from growing without bound as filters change.
    if (trendData.size > 40) {
      for (const [k, v] of trendData) {
        if (trendData.size <= 30) break;
        if (k !== key && !v.loading && !v.more) trendData.delete(k);
      }
    }
    trendData.set(key, {
      games: prev ? prev.games : [], total: prev ? prev.total : null, next: prev ? prev.next : null,
      at: prev ? prev.at : 0, loading: true,
    });
  }

  let page = null;
  let error = null;
  try {
    page = await invoke("browse_store", { tab, query, filters, start: more ? prev.next : 0 });
  } catch (e) {
    error = typeof e === "string" ? e : "Couldn't reach the Steam store";
  }
  const entry = trendData.get(key);
  if (!entry) return;
  const games = page && Array.isArray(page.games) ? page.games : [];

  if (more) {
    entry.more = false;
    if (error) {
      entry.moreError = error;
    } else {
      const seen = new Set(entry.games.map((t) => t.app_id));
      const fresh = games.filter((t) => !seen.has(t.app_id));
      entry.games = entry.games.concat(fresh);
      entry.next = page.next_start ?? null;
      if (page.total != null) entry.total = page.total;
      entry.emptyRuns = fresh.length ? 0 : (entry.emptyRuns || 0) + 1;
      if (currentPage === "trend" && trendKey() === key) appendTrendCards(fresh);
      return;
    }
  } else if (error) {
    entry.loading = false;
    entry.error = error;
  } else {
    trendData.set(key, {
      games, total: page.total ?? null, next: page.next_start ?? null, at: Date.now(),
      emptyRuns: games.length ? 0 : 1,
    });
  }
  if (currentPage === "trend" && trendKey() === key) renderTrendResults();
}

function findTrend(appId) {
  const entry = trendData.get(trendKey());
  return entry ? entry.games.find((t) => t.app_id === appId) : null;
}

// The user's copy of a trending game: installed, or owned but not installed.
function trendLibraryGame(t) {
  return findGame(`steam_${t.app_id}`) || null;
}

function trendVisible(games) {
  return trendFilters.hide_library ? games.filter((t) => !trendLibraryGame(t)) : games;
}

function trendRelease(t) {
  if (!t.release_date) return t.release_message || (t.coming_soon ? "Coming soon" : "");
  const d = new Date(t.release_date * 1000);
  if (t.coming_soon) {
    switch (t.release_display) {
      case "date_full": break;
      case "date_month": return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
      case "date_quarter": return `Q${Math.floor(d.getMonth() / 3) + 1} ${d.getFullYear()}`;
      case "date_year": return String(d.getFullYear());
      default: return t.release_message || "Coming soon";
    }
  }
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

// Price as HTML ("" when Steam gave none).
function trendPrice(t) {
  if (t.is_free) return "Free to play";
  if (!t.price) return "";
  return t.discount_pct > 0 && t.original_price
    ? `<s>${esc(t.original_price)}</s> ${esc(t.price)}`
    : esc(t.price);
}

function renderTrendCover(t, overlay = "") {
  const [first, ...rest] = t.covers || [];
  if (first) {
    const fb = rest.length ? ` data-fb="${esc(rest.join("|"))}"` : "";
    return `<div class="cv" style="background:#222">
      <img src="${esc(first)}"${fb} alt="${esc(t.name)}" loading="lazy">${overlay}
    </div>`;
  }
  const { background, color } = getCoverGradient(t.name);
  return `<div class="cv" style="background:${background};color:${color}">
    <span class="nm">${esc(t.name)}</span>${overlay}
  </div>`;
}

function renderTrendCard(t) {
  const lib = trendLibraryGame(t);
  let overlay = "";
  if (lib) overlay += `<span class="tag">${lib.owned ? "Owned" : "Installed"}</span>`;
  if (t.discount_pct > 0 && !t.coming_soon) overlay += `<span class="tag off">-${t.discount_pct}%</span>`;
  if (lib && !lib.owned) overlay += `<span class="play" data-play="${esc(lib.id)}">Play</span>`;
  const sub = t.coming_soon ? esc(trendRelease(t)) : (trendPrice(t) || esc(trendRelease(t)));
  return `<button class="g" data-trend="${esc(t.app_id)}">
      ${renderTrendCover(t, overlay)}
      <div class="grow"><b title="${esc(t.name)}">${esc(t.name)}</b></div>
      <span class="pr">${sub}</span>
    </button>`;
}

// Steam's tag list and the store languages for the filter panel, once.
function loadTrendOptions() {
  if (!isTauri || trendOptions || trendOptionsLoading) return;
  trendOptionsLoading = true;
  invoke("store_filter_options")
    .then((o) => { trendOptions = o && Array.isArray(o.tags) ? o : null; })
    .catch(() => {})
    .then(() => {
      trendOptionsLoading = false;
      if (currentPage === "trend" && trendFiltersOpen) renderTrendPanel();
    });
}

function trendTagName(id) {
  const tag = trendOptions && trendOptions.tags.find((t) => Number(t.id) === id);
  return tag ? tag.name : `Tag ${id}`;
}

// Tag chips: off → must have → must not have → off.
function trendTagChip(id, name) {
  const inc = trendFilters.tags.includes(id);
  const exc = trendFilters.exclude_tags.includes(id);
  const title = inc ? "Only games with this tag. Click to hide games with it instead."
    : exc ? "Games with this tag are hidden. Click to clear."
    : "Click to show only games with this tag.";
  return `<button class="chip ${inc ? "on" : exc ? "no" : ""}" data-ttag="${id}" title="${title}" aria-pressed="${inc}">${exc ? "&minus; " : ""}${esc(name)}</button>`;
}

function trendChip(kind, value, label, on, title = "") {
  return `<button class="chip ${on ? "on" : ""}" data-tfc="${kind}:${esc(String(value))}" aria-pressed="${on}"${title ? ` title="${esc(title)}"` : ""}>${esc(label)}</button>`;
}

const TREND_UPCOMING_OFF = "Not used on Upcoming: unreleased games have no reviews or price yet";

function trendSelect(id, options, value, label, disabled = false) {
  const off = disabled ? ` disabled title="${esc(TREND_UPCOMING_OFF)}"` : "";
  return `<select class="sel" id="${id}" aria-label="${esc(label)}"${off}>${options
    .map(([v, l]) => `<option value="${esc(v)}"${String(value) === v ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
}

function trendPanelHtml() {
  const f = trendFilters;
  const tab = trendTab();
  const up = tab === "upcoming";
  const tagRow = [];
  const shown = new Set();
  if (trendOptions) {
    const byName = new Map(trendOptions.tags.map((t) => [t.name.toLowerCase(), Number(t.id)]));
    for (const name of TREND_QUICK_TAGS) {
      const id = byName.get(name.toLowerCase());
      if (id != null && !shown.has(id)) { shown.add(id); tagRow.push(trendTagChip(id, name)); }
    }
  }
  for (const id of [...f.tags, ...f.exclude_tags]) {
    if (!shown.has(id)) { shown.add(id); tagRow.push(trendTagChip(id, trendTagName(id))); }
  }
  const tagList = trendOptions
    ? `<datalist id="ttaglist">${trendOptions.tags.map((t) => `<option value="${esc(t.name)}">`).join("")}</datalist>`
    : "";
  const langs = [["", "Any language"], ...((trendOptions && trendOptions.languages) || []).map((l) => [l.id, l.name])];
  if (f.language && !langs.some(([v]) => v === f.language)) langs.push([f.language, f.language]);

  const row = (label, body) => `<div class="fr"><span class="fl">${label}</span><div class="fc">${body}</div></div>`;
  const priceSeg = [["", "Any"], ["free", "Free"], ["paid", "Paid"]].map(([v, l]) =>
    `<button class="${f.price === v ? "on" : ""}" data-tfc="price:${v}" aria-pressed="${f.price === v}">${l}</button>`).join("");
  return `
    ${row("Genres &amp; tags", `${tagRow.join("")}
      <input class="fin wide" id="ttagin" list="ttaglist" placeholder="${trendOptions ? "Add any Steam tag…" : "Loading tags…"}" aria-label="Add a tag filter"${trendOptions ? "" : " disabled"}>${tagList}`)}
    ${row("Players", TREND_PLAYERS.map(([id, l]) => trendChip("cat", id, l, f.categories.includes(id))).join(""))}
    ${row("Features", TREND_FEATURES.map(([id, l]) => trendChip("cat", id, l, f.categories.includes(id))).join(""))}
    ${row("Price", `<div class="seg">${priceSeg}</div>
      <input class="fin" id="tmaxp" inputmode="decimal" placeholder="Max price" value="${esc(f.max_price)}" aria-label="Highest price, in your Steam store's currency" title="${up ? esc(TREND_UPCOMING_OFF) : "Highest price, in your Steam store's currency"}"${up ? " disabled" : ""}>
      ${trendChip("flag", "on_sale", "On sale", f.on_sale)}`)}
    ${row("Reviews", `${trendSelect("trpct", TREND_REVIEW_PCT, up ? "" : f.min_review_pct, "Lowest share of positive reviews", up)}
      ${trendSelect("trcnt", TREND_REVIEW_COUNT, up ? "" : f.min_review_count, "Fewest reviews", up)}`)}
    ${row("Release", `${trendSelect("twithin", TREND_WITHIN, up ? "" : f.released_within_days, "Released within", up)}
      <input class="fin" id="tymin" inputmode="numeric" placeholder="From year" value="${esc(f.year_min)}" aria-label="Released in or after year">
      <input class="fin" id="tymax" inputmode="numeric" placeholder="To year" value="${esc(f.year_max)}" aria-label="Released in or before year">
      ${trendChip("flag", "hide_early_access", "Hide Early Access", f.hide_early_access)}`)}
    ${row("Platform", `${trendSelect("tos", [["", "Any OS"], ["win", "Windows"], ["mac", "macOS"], ["linux", "Linux / SteamOS"]], f.os, "Operating system")}
      ${trendChip("deck", 3, "Deck Verified", f.deck.includes(3))}
      ${trendChip("deck", 2, "Deck Playable", f.deck.includes(2))}
      ${trendChip("flag", "vr", "VR", f.vr, "Supports VR headsets")}`)}
    ${row("Language", trendSelect("tlang", langs, f.language, "Supported language"))}
    ${row("Library", `${trendChip("flag", "hide_library", "Hide games I own or have installed", f.hide_library)}
      <button class="btn o sm" data-tfclear${trendFilterCount() ? "" : " disabled"}>Clear all filters</button>`)}`;
}

// Re-draw just the filter panel, keeping focus (and the caret) where it was.
function renderTrendPanel() {
  const box = $("#tfil");
  if (!box) return;
  const a = document.activeElement;
  let focusSel = null;
  if (a && box.contains(a)) {
    if (a.id) focusSel = `#${a.id}`;
    else if (a.dataset.ttag) focusSel = `[data-ttag="${a.dataset.ttag}"]`;
    else if (a.dataset.tfc !== undefined) focusSel = `[data-tfc="${CSS.escape(a.dataset.tfc)}"]`;
  }
  const caret = a && a.tagName === "INPUT" ? a.selectionStart : null;
  box.innerHTML = trendPanelHtml();
  bindTrendPanel();
  updateTrendHead();
  if (focusSel) {
    const el = box.querySelector(focusSel);
    if (el) {
      el.focus();
      if (caret != null && el.setSelectionRange) el.setSelectionRange(caret, caret);
    }
  }
}

function bindTrendPanel() {
  const set = (id, key, delay = 0) => {
    const el = $(`#${id}`);
    if (!el) return;
    const select = el.tagName === "SELECT";
    const apply = () => { trendFilters[key] = el.value; trendFiltersChanged(delay, select); };
    if (select) el.onchange = apply;
    else el.oninput = apply;
  };
  set("tmaxp", "max_price", 700);
  set("tymin", "year_min", 700);
  set("tymax", "year_max", 700);
  set("trpct", "min_review_pct");
  set("trcnt", "min_review_count");
  set("twithin", "released_within_days");
  set("tos", "os");
  set("tlang", "language");
  const tagIn = $("#ttagin");
  if (tagIn && trendOptions) {
    const add = () => {
      const name = tagIn.value.trim().toLowerCase();
      const tag = trendOptions.tags.find((t) => t.name.toLowerCase() === name);
      if (!tag) return;
      const id = Number(tag.id);
      trendFilters.exclude_tags = trendFilters.exclude_tags.filter((x) => x !== id);
      if (!trendFilters.tags.includes(id)) trendFilters.tags.push(id);
      tagIn.value = "";
      trendFiltersChanged();
    };
    // Picking from the list fills in the whole name at once.
    tagIn.oninput = add;
    tagIn.onkeydown = (e) => { if (e.key === "Enter") add(); };
  }
}

// A filter changed: save it, show it, and (after `delay`, so typing doesn't
// fire a search per key) load the matching results.
function trendFiltersChanged(delay = 0, redrawPanel = true) {
  saveTrendFilters();
  if (redrawPanel) renderTrendPanel();
  else updateTrendHead();
  clearTimeout(trendRefreshTimer);
  trendRefreshTimer = setTimeout(() => {
    if (currentPage === "trend") renderTrendResults();
  }, delay || 250);
}

function clearTrendFilters() {
  trendFilters = emptyTrendFilters();
  trendFiltersChanged();
}

// Handles a click on a filter chip; true when it was one.
function trendChipClick(target) {
  const tagBtn = target.closest("[data-ttag]");
  if (tagBtn) {
    const id = Number(tagBtn.dataset.ttag);
    const f = trendFilters;
    if (f.tags.includes(id)) {
      f.tags = f.tags.filter((x) => x !== id);
      f.exclude_tags.push(id);
    } else if (f.exclude_tags.includes(id)) {
      f.exclude_tags = f.exclude_tags.filter((x) => x !== id);
    } else {
      f.tags.push(id);
    }
    trendFiltersChanged();
    return true;
  }
  const chip = target.closest("[data-tfc]");
  if (!chip) return false;
  const [kind, value] = chip.dataset.tfc.split(":");
  const f = trendFilters;
  const toggle = (list, v) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  if (kind === "cat") f.categories = toggle(f.categories, Number(value));
  else if (kind === "deck") f.deck = toggle(f.deck, Number(value));
  else if (kind === "price") f.price = value;
  else if (kind === "flag" && value in f) f[value] = !f[value];
  trendFiltersChanged();
  return true;
}

function trendTotalText(entry) {
  if (!entry) return "";
  if (entry.total != null && !trendFilters.hide_library) return Number(entry.total).toLocaleString();
  const n = trendVisible(entry.games).length;
  if (!n) return "";
  return `${n.toLocaleString()}${entry.next != null ? "+" : ""}`;
}

function updateTrendHead() {
  const n = trendFilterCount();
  const btn = $("#tfbtn");
  if (btn) {
    btn.innerHTML = `Filters${n ? ` <em>${n}</em>` : ""}`;
    btn.classList.toggle("on", trendFiltersOpen);
    btn.setAttribute("aria-expanded", String(trendFiltersOpen));
  }
  const count = $("#tcount");
  if (count) count.textContent = trendTotalText(trendData.get(trendKey()));
}

function renderTrending() {
  const active = document.activeElement;
  const focused = active && active.id === "tq";
  const caret = focused ? active.selectionStart : 0;

  loadTrendOptions();
  renderTop();

  const tab = trendTab();
  const searching = tab === "search";
  const tabs = TREND_LISTS.map(([k, label]) => {
    const on = !searching && trendList === k;
    return `<button role="tab" aria-selected="${on}" class="${on ? "on" : ""}" data-tl="${k}">${esc(label)}</button>`;
  }).join("");
  const sorts = TREND_SORTS[tab];
  const sort = sorts ? trendSelect("tsort", sorts, trendSort[tab], "Sort") : "";
  const info = searching ? `Steam results for &ldquo;${esc(trendQuery)}&rdquo;` : "From the Steam store";
  scrollEl.innerHTML = `<div class="tabs"><div class="seg" role="tablist" aria-label="Trending lists">${tabs}</div>
      <button class="btn o sm tfb" id="tfbtn" aria-controls="tfil"></button>${sort}
      <span class="tinfo">${info}</span></div>
    <div class="tfil" id="tfil"${trendFiltersOpen ? "" : " hidden"}></div>
    <div id="tres"></div>`;
  if (trendFiltersOpen) { $("#tfil").innerHTML = trendPanelHtml(); bindTrendPanel(); }
  const ts = $("#tsort");
  if (ts) ts.onchange = () => { trendSort[tab] = ts.value; scrollEl.scrollTop = 0; renderTrending(); };
  renderTrendResults();

  const tq = $("#tq");
  if (tq) {
    if (focused) { tq.focus(); tq.setSelectionRange(caret, caret); }
    tq.oninput = () => {
      trendInput = tq.value;
      clearTimeout(trendSearchTimer);
      trendSearchTimer = setTimeout(applyTrendSearch, 400);
    };
    tq.onkeydown = (e) => {
      if (e.key === "Enter") { clearTimeout(trendSearchTimer); applyTrendSearch(); }
    };
  }
}

// The results grid (and the footer under it) for what the page is showing,
// loading it first if needed.
function renderTrendResults() {
  const box = $("#tres");
  if (!box) return;
  const key = trendKey();
  let entry = trendData.get(key);
  if (isTauri && (!entry || (!entry.loading && !entry.more && !entry.error && Date.now() - entry.at > TREND_STALE_MS))) {
    loadTrend(key);
    entry = trendData.get(key);
  }
  updateTrendHead();
  const searching = key.startsWith("search|");
  const filtered = trendFilterCount() > 0;

  let body;
  if (!isTauri) {
    body = `<div class="empty">Trending needs the desktop app.</div>`;
  } else if (!entry || (entry.loading && !entry.games.length)) {
    body = `<div class="grid" aria-busy="true">` +
      `<div class="g"><div class="cv sk"></div><div class="sk-t"></div></div>`.repeat(12) + `</div>`;
  } else if (entry.error && !entry.games.length) {
    body = `<div class="empty">${esc(entry.error)}<br>
      <button class="btn o" id="tretry" style="margin-top:14px">Try again</button></div>`;
  } else {
    const games = trendVisible(entry.games);
    if (!games.length && entry.next == null) {
      const what = searching
        ? `No games on Steam match &ldquo;${esc(trendQuery)}&rdquo;${filtered ? " with these filters" : ""}.`
        : filtered ? "No games in this list match these filters." : "Nothing in this list right now.";
      body = `<div class="empty">${what}${filtered
        ? `<br><button class="btn o" data-tfclear style="margin-top:14px">Clear all filters</button>` : ""}</div>`;
    } else {
      // Tight filters can leave the pages read so far empty while more remain.
      const none = games.length ? "" : `<div class="empty">Nothing matched in the results checked so far.</div>`;
      body = `${none}<div class="grid">${games.map(renderTrendCard).join("")}</div><div class="tmore" id="tmore"></div>`;
    }
  }
  box.innerHTML = body;
  renderTrendFooter();
  queueTrendMore();
}

// Add a further page's cards to the grid without re-drawing it (so images
// and the scroll position stay put).
function appendTrendCards(games) {
  const grid = $("#tres .grid:not([aria-busy])");
  if (!grid) { renderTrendResults(); return; }
  const shown = trendVisible(games);
  if (shown.length) {
    grid.insertAdjacentHTML("beforeend", shown.map(renderTrendCard).join(""));
    const none = $("#tres > .empty");
    if (none) none.remove();
  }
  updateTrendHead();
  const entry = trendData.get(trendKey());
  if (entry && entry.next == null && !grid.querySelector(".g")) { renderTrendResults(); return; }
  renderTrendFooter();
  queueTrendMore();
}

function renderTrendFooter() {
  const foot = $("#tmore");
  if (!foot) return;
  const entry = trendData.get(trendKey());
  if (!entry) { foot.innerHTML = ""; return; }
  if (entry.more) {
    foot.innerHTML = `<span class="tk">Loading more…</span>`;
  } else if (entry.moreError) {
    foot.innerHTML = `<span class="tk err">${esc(entry.moreError)}</span> <button class="btn o sm" id="tmorebtn">Try again</button>`;
  } else if (entry.next != null) {
    foot.innerHTML = `<button class="btn o sm" id="tmorebtn">Load more</button>`;
  } else if (entry.games.length) {
    foot.innerHTML = `<span class="tk">End of results</span>`;
  } else {
    foot.innerHTML = "";
  }
}

// Load the next page when the grid's end is near (or the page is too short to
// scroll). Stops auto-loading after a few pages in a row added nothing; the
// Load more button still works then.
let trendMoreQueued = false;
function queueTrendMore() {
  if (trendMoreQueued) return;
  trendMoreQueued = true;
  requestAnimationFrame(() => {
    trendMoreQueued = false;
    maybeLoadMoreTrend();
  });
}

function maybeLoadMoreTrend() {
  if (currentPage !== "trend" || !isTauri) return;
  const key = trendKey();
  const entry = trendData.get(key);
  if (!entry || entry.loading || entry.more || entry.moreError || entry.next == null) return;
  if ((entry.emptyRuns || 0) >= 3) return;
  const left = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
  if (left > 900) return;
  loadTrend(key, true);
  renderTrendFooter();
}

function loadMoreTrend() {
  const key = trendKey();
  const entry = trendData.get(key);
  if (!entry) return;
  entry.moreError = null;
  entry.emptyRuns = 0;
  loadTrend(key, true);
  renderTrendFooter();
}

function applyTrendSearch() {
  const q = trendInput.trim();
  if (q === trendQuery) return;
  trendQuery = q;
  scrollEl.scrollTop = 0;
  if (currentPage === "trend") renderTrending();
}

function openTrendPanel(t) {
  selectedGame = null;
  trendSelected = t;
  const lib = trendLibraryGame(t);
  let main = "";
  let actsAttrs = ` class="acts"`;
  if (lib && !lib.owned) {
    main = `<button class="btn" data-play="${esc(lib.id)}">Play</button>`;
  } else if (lib) {
    main = `<button class="btn" data-install="${esc(lib.id)}">Install</button>`;
    actsAttrs = ` class="acts own ${installBusy(lib) ? "busy" : ""}" data-own="${esc(lib.id)}"`;
  }

  const names = (list) => (list || []).map(esc).join(", ");
  const rows = [];
  if (lib) rows.push(["Library", lib.owned ? "In your Steam library, not installed" : "Installed"]);
  if (lib && lib.owned) rows.push(["Install", `<span data-inst="${esc(lib.id)}">${installLine(lib)}</span>`]);
  if (t.developers.length) rows.push(["Developer", names(t.developers)]);
  if (t.publishers.length && names(t.publishers) !== names(t.developers)) rows.push(["Publisher", names(t.publishers)]);
  const rel = trendRelease(t);
  if (rel) rows.push([t.coming_soon ? "Release" : "Released", esc(rel) + (t.early_access ? " · Early Access" : "")]);
  if (t.review_label) {
    rows.push(["Reviews", `${esc(t.review_label)} · ${t.review_percent}% of ${Number(t.review_count).toLocaleString()}`]);
  }
  const price = trendPrice(t);
  if (price && !t.coming_soon) {
    rows.push(["Price", price + (t.discount_pct > 0 ? ` <em class="dc">-${t.discount_pct}%</em>` : "")]);
  }
  const players = TREND_PLAYERS.filter(([id]) => (t.categories || []).includes(id)).map(([, l]) => l);
  if (players.length) rows.push(["Players", esc(players.join(", "))]);
  const plat = [t.windows && "Windows", t.mac && "macOS", t.linux && "Linux"].filter(Boolean);
  if (t.deck === 3) plat.push("Steam Deck Verified");
  else if (t.deck === 2) plat.push("Steam Deck Playable");
  if (t.vr) plat.push("VR");
  if (plat.length) rows.push(["Platforms", esc(plat.join(" · "))]);
  if (t.tag_ids && t.tag_ids.length && trendOptions) {
    rows.push(["Tags", t.tag_ids.slice(0, 10).map((id) =>
      `<button class="tlnk" data-addtag="${id}" title="Show only games with this tag">${esc(trendTagName(id))}</button>`).join("")]);
  }
  // Filled in by loadTorrentInfo once the catalogs answer.
  rows.push(["Torrents", `<span data-torrent="${esc(t.app_id)}"></span>`]);

  panelEl.innerHTML = `<button class="x" id="px" aria-label="Close">&times;</button>
    ${renderTrendCover(t)}
    <h2>${esc(t.name)}</h2>
    ${t.description ? `<p>${esc(t.description)}</p>` : ""}
    <div${actsAttrs}>${main}<button class="btn o" id="tstore">View on Steam</button></div>
    <dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`;
  panelEl.classList.add("on");
  scrimEl.classList.add("on");
  loadTorrentInfo(t);
}

// Look up whether the community download catalogs have a torrent for a
// Discover game — once per session per game, in the background.
function loadTorrentInfo(t) {
  if (!isTauri) return;
  const key = t.app_id;
  const entry = torrentCache.get(key);
  if (entry && (entry.checking || entry.result || entry.error)) {
    renderTorrentRow(t);
    return;
  }
  torrentCache.set(key, { checking: true });
  renderTorrentRow(t);
  invoke("check_torrent_availability", { name: t.name })
    .then((result) => torrentCache.set(key, { result }))
    .catch((e) => torrentCache.set(key, { error: typeof e === "string" ? e : "Check failed" }))
    .then(() => {
      // Only touch the panel if it's still showing this game.
      if (trendSelected && trendSelected.app_id === key) renderTorrentRow(t);
    });
}

// The Torrents row's contents: the sources that have the game, or — when no
// catalog knows it, or none could be read — plain site searches, so the row
// is a way out either way.
function renderTorrentRow(t) {
  const box = document.querySelector(`[data-torrent="${CSS.escape(t.app_id)}"]`);
  if (!box) return;
  const entry = torrentCache.get(t.app_id);
  if (!entry || entry.checking) {
    box.innerHTML = `<span class="tk">Checking…</span>`;
    return;
  }
  if (entry.error) {
    box.innerHTML = `<span class="tk err">Couldn't check</span>${torrentSearchLinks(t.name)}`;
    return;
  }
  const res = entry.result;
  if (res && res.available && res.sources.length) {
    box.innerHTML = `<span class="tk ok">✓ Available</span>` +
      res.sources.map((s) => `<button class="tlnk" data-turl="${esc(s.url)}">${esc(s.name)}</button>`).join("") +
      // Online-Fix has crack fixes rather than torrents, so it never answers
      // the availability check — but it's still a place to look.
      `<button class="tlnk" data-turl="${esc(onlineFixUrl(t.name))}">Online-Fix</button>`;
    return;
  }
  box.innerHTML = `<span class="tk no">Not in catalogs</span>${torrentSearchLinks(t.name)}`;
}

// Online-Fix's search page (DataLife Engine, so it's the index.php form).
function onlineFixUrl(name) {
  return `https://online-fix.me/index.php?do=search&subaction=search&story=${encodeURIComponent(name)}`;
}

// Site-search buttons for the game's title. They live here because the panel
// needs them even when the backend is offline — that's the whole fallback.
function torrentSearchLinks(name) {
  const q = encodeURIComponent(name);
  return [
    ["FitGirl", `https://fitgirl-repacks.site/?s=${q}`],
    ["DODI", `https://dodi-repacks.site/?s=${q}`],
    ["1337x", `https://1337x.to/search/${q}/1/`],
    ["Online-Fix", onlineFixUrl(name)],
  ].map(([label, url]) => `<button class="tlnk" data-turl="${esc(url)}">${esc(label)}</button>`).join("");
}

// ── Details panel ────────────────────────────────────────────────────────────
function openPanel(game) {
  if (game.owned) { openOwnedPanel(game); return; }
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

// Details for a game the user owns but hasn't installed.
function openOwnedPanel(game) {
  selectedGame = game;
  const hidden = hiddenGames.has(game.id);
  panelEl.innerHTML = `<button class="x" id="px" aria-label="Close">&times;</button>
    ${renderCover(game)}
    <h2>${esc(game.name)}</h2>
    <p>In your ${esc(sourceName(game))} library, not installed on this PC${hidden ? " · hidden" : ""}</p>
    <div class="acts own ${installBusy(game) ? "busy" : ""}" data-own="${esc(game.id)}">
      <button class="btn" data-install="${esc(game.id)}">Install</button>
      <button class="btn o" id="pstore">Store page</button>
      <button class="btn o" id="phide">${hidden ? "Unhide" : "Hide"}</button>
    </div>
    <dl>
      <dt>Install</dt><dd data-inst="${esc(game.id)}">${installLine(game)}</dd>
    </dl>`;
  panelEl.classList.add("on");
  scrimEl.classList.add("on");
}

// The game's page on its store's website, or null when there's no good one.
// Steam has a page per app id; the others are searched by title (Epic's
// catalog cache has no store-page slug, and the other scanners know no ids).
function storePageUrl(game) {
  const q = encodeURIComponent(game.name || "");
  const steamId = game.owned && game.store === "steam" ? game.app_id : (/^steam_(\d+)$/.exec(game.id || "") || [])[1];
  if (steamId) return `https://store.steampowered.com/app/${encodeURIComponent(steamId)}/`;
  switch (game.owned ? game.store : game.source) {
    case "epic":
    case "Epic": return `https://store.epicgames.com/en-US/browse?q=${q}&sortBy=relevancy`;
    case "GOG": return `https://www.gog.com/en/games?query=${q}`;
    case "itch.io": return `https://itch.io/search?q=${q}`;
    case "Xbox": return `https://apps.microsoft.com/search?query=${q}`;
    default: return null;
  }
}

function openStorePage(game) {
  const url = storePageUrl(game);
  if (url) openExternal(url);
  else toast("No store page for this game");
}

function closePanel() {
  if (fndEl.classList.contains("on")) foundNotNow();
  panelEl.classList.remove("on");
  scrimEl.classList.remove("on");
  dlgEl.classList.remove("on");
  covDlgEl.classList.remove("on");
  selectedGame = null;
  trendSelected = null;
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

// Add a local game to customGames (the caller saves). The install folder
// defaults to the executable's folder.
let customSeq = 0;
function createCustomGame({ exe, name, args = "", art = "", installPath = "" }) {
  const game = {
    id: `custom-${Date.now()}-${customSeq++}`,
    name,
    description: null,
    install_path: installPath || exe.replace(/[^\\/]+$/, ""),
    executable_path: exe,
    launch_command: args ? exe + " " + args : exe,
    cover_image_path: art || null,
    source: "Custom",
    last_played: null,
    total_playtime_seconds: 0,
    is_installed: true,
  };
  customGames.push(game);
  return game;
}

function addGameFromDialog() {
  const exe = $("#dlg-exe").value.trim();
  const name = $("#dlg-name").value.trim();
  const args = $("#dlg-args").value.trim();
  const art = ($("#dlg-art")?.value || "").trim();
  if (!exe || !name) { toast("Please fill in executable and name"); return; }
  createCustomGame({ exe, name, args, art });
  saveCustomGames();
  closeDialog();
  toast("Added " + name);
  renderAll();
}

function removeCustomGame(game) {
  if (!confirm(`Remove "${game.name}" from your library?`)) return;
  customGames = customGames.filter((g) => g.id !== game.id);
  saveCustomGames();
  // If it came from a game folder, count the folder as ignored: it isn't
  // offered again right away, but "Suggest again" brings it back.
  if (isTauri && game.install_path) markFolders([game.install_path], "ignored");
  toast("Removed " + game.name);
  renderAll();
}

// The add-game "Browse" button. In the desktop app this uses the native picker:
// a webview file input only reveals the file name, not its full path.
async function browseExecutable() {
  if (!isTauri) { $("#dlg-file").click(); return; }
  try {
    const exe = await invoke("pick_executable");
    if (exe) $("#dlg-exe").value = exe;
  } catch (e) {
    console.error("File picker failed:", e);
    toast("Couldn't open the file picker");
  }
}

// ── Game folders ─────────────────────────────────────────────────────────────
async function loadGameFolders() {
  if (!isTauri) return;
  try { gameFolders = await invoke("get_game_folders"); } catch { /* ignore */ }
}

// Custom games live here, not in the backend, so it gets their paths from us.
function customGamePaths() {
  return customGames.flatMap((g) => [g.install_path, g.executable_path]).filter(Boolean);
}

// Look for new games in the game folders. With { manual: true } (Check now, or
// right after adding a folder) results open at once and "nothing found" is said.
let folderCheckRunning = false;
async function checkGameFolders({ manual = false } = {}) {
  if (!isTauri || folderCheckRunning) return;
  if (!gameFolders.folders.length) {
    if (manual) toast("Add a game folder first");
    return;
  }
  folderCheckRunning = true;
  try {
    const found = await invoke("check_game_folders", { knownPaths: customGamePaths() });
    const list = Array.isArray(found) ? found : [];
    if (manual) list.forEach((c) => snoozedFolders.delete(c.folder));
    foundGames = list.filter((c) => !snoozedFolders.has(c.folder));
    if (manual && !foundGames.length) {
      toast("No new games found. Folders changed in the last minute are checked later.");
    }
    if (manual && foundGames.length && !overlayOpen()) openFoundDialog(foundGames);
    else presentFoundGames();
  } catch (e) {
    console.error("Folder check failed:", e);
    if (manual) toast("Couldn't check your game folders");
  } finally {
    folderCheckRunning = false;
  }
}

function overlayOpen() {
  return [dlgEl, covDlgEl, fndEl, panelEl, padEl].some((el) => el.classList.contains("on"));
}

// One new game is asked about in a popup, but only while the window is in
// front and nothing else is open, so it never lands mid-game. Several games
// (or a popup that has to wait) get a banner that opens the checklist.
function presentFoundGames() {
  renderFoundBanner();
  const inFront = !document.hidden && document.hasFocus();
  if (foundGames.length === 1 && inFront && !overlayOpen()) openFoundDialog(foundGames);
}

function renderFoundBanner() {
  const n = foundGames.length;
  if (!n || fndEl.classList.contains("on")) {
    foundBarEl.classList.remove("on");
    foundBarEl.innerHTML = "";
    return;
  }
  const text = n === 1
    ? `New game found in your game folders: <b>${esc(foundGames[0].title)}</b>`
    : `<b>${n} new games</b> found in your game folders`;
  foundBarEl.innerHTML = `<span>${text}</span>
    <button class="btn" id="found-review">Review</button>
    <button class="btn o" id="found-later">Not now</button>`;
  foundBarEl.classList.add("on");
}

// `D:\Games\Hades\bin\Hades.exe` is shown as `bin\Hades.exe` under its folder.
function relativeToFolder(folder, path) {
  const f = folder.replace(/[\\/]+$/, "");
  return path.toLowerCase().startsWith(f.toLowerCase())
    ? path.slice(f.length).replace(/^[\\/]+/, "")
    : path;
}

function openFoundDialog(list) {
  if (!list.length) return;
  foundShown = list.slice();
  const exeOptions = (c) => c.exes
    .map((x, i) => `<option value="${i}">${esc(relativeToFolder(c.folder, x))}</option>`)
    .join("");
  if (foundShown.length === 1) {
    const c = foundShown[0];
    fndEl.innerHTML = `<h3>New game found</h3>
      <span style="color:var(--mute)">In ${esc(c.parent)}. Add it to your library?</span>
      <label class="fld">Name<div class="in"><input data-fnd-name="0" value="${esc(c.title)}"></div></label>
      <label class="fld">Executable<div class="in"><select class="sel" data-fnd-exe="0">${exeOptions(c)}</select></div></label>
      <span class="fndp">${esc(c.folder)}</span>
      <div class="dacts"><button class="btn o" id="fnd-ignore">Ignore</button><button class="btn o" id="fnd-later">Not now</button><button class="btn" id="fnd-add">Add game</button></div>`;
  } else {
    fndEl.innerHTML = `<h3>${foundShown.length} new games found</h3>
      <span style="color:var(--mute)">Tick the ones to add. Unticked folders won't be suggested again.</span>
      <div class="fndlist">${foundShown.map((c, i) => `
        <div class="fndrow">
          <input type="checkbox" data-fnd-pick="${i}" checked aria-label="Add ${esc(c.title)}">
          <div class="fndf">
            <input data-fnd-name="${i}" value="${esc(c.title)}" aria-label="Name">
            <select class="sel" data-fnd-exe="${i}" aria-label="Executable for ${esc(c.title)}">${exeOptions(c)}</select>
            <span class="fndp">${esc(c.folder)}</span>
          </div>
        </div>`).join("")}</div>
      <div class="dacts"><button class="btn o" id="fnd-later">Not now</button><button class="btn" id="fnd-add">Add selected</button></div>`;
  }
  fndEl.classList.add("on");
  scrimEl.classList.add("on");
  renderFoundBanner();
}

function closeFoundDialog() {
  fndEl.classList.remove("on");
  if (!panelEl.classList.contains("on")) scrimEl.classList.remove("on");
  foundShown = [];
  renderFoundBanner();
}

// Drop answered folders from the pending list.
function forgetFound(folders) {
  const done = new Set(folders);
  foundGames = foundGames.filter((c) => !done.has(c.folder));
}

async function markFolders(folders, status) {
  if (!folders.length) return;
  try { gameFolders = await invoke("mark_game_folders", { folders, status }); }
  catch (e) { console.error("Couldn't save folder answer:", e); }
}

async function addFoundGames() {
  const single = foundShown.length === 1;
  const picked = [];
  const skipped = [];
  foundShown.forEach((c, i) => {
    const ticked = single || fndEl.querySelector(`[data-fnd-pick="${i}"]`)?.checked;
    if (!ticked) { skipped.push(c.folder); return; }
    const name = (fndEl.querySelector(`[data-fnd-name="${i}"]`)?.value || "").trim() || c.title;
    const exe = c.exes[Number(fndEl.querySelector(`[data-fnd-exe="${i}"]`)?.value) || 0] || c.exes[0];
    picked.push({ folder: c.folder, name, exe });
  });
  if (!picked.length) { toast("Tick at least one game, or choose Not now"); return; }
  // The game folder (not the exe's subfolder) is the install folder, so
  // "Open install folder" and the size cover the whole game.
  for (const p of picked) createCustomGame({ exe: p.exe, name: p.name, installPath: p.folder });
  saveCustomGames();
  await markFolders(picked.map((p) => p.folder), "added");
  await markFolders(skipped, "ignored");
  forgetFound([...picked.map((p) => p.folder), ...skipped]);
  closeFoundDialog();
  toast(picked.length === 1 ? `Added ${picked[0].name}` : `Added ${picked.length} games`);
  renderAll();
}

async function ignoreFoundGame() {
  const c = foundShown[0];
  if (!c) return;
  await markFolders([c.folder], "ignored");
  forgetFound([c.folder]);
  closeFoundDialog();
  toast(`Won't suggest ${c.title} again`);
  if (currentPage === "set") renderSettings();
}

// "Not now": leave it until the next launch (or Check now).
function foundNotNow() {
  const list = foundShown.length ? foundShown : foundGames;
  list.forEach((c) => snoozedFolders.add(c.folder));
  forgetFound(list.map((c) => c.folder));
  closeFoundDialog();
}

async function addGameFolder() {
  if (!isTauri) { toast("Game folders need the desktop app"); return; }
  try {
    const path = await invoke("pick_folder", { title: "Choose a folder you keep games in" });
    if (!path) return;
    gameFolders = await invoke("add_game_folder", { path });
    if (currentPage === "set") renderSettings();
    await checkGameFolders({ manual: true });
  } catch (e) {
    console.error("Add game folder failed:", e);
    toast(typeof e === "string" ? e : "Couldn't add that folder");
  }
}

async function removeGameFolder(path) {
  try {
    gameFolders = await invoke("remove_game_folder", { path });
    const key = path.replace(/[\\/]+$/, "").toLowerCase();
    foundGames = foundGames.filter((c) => c.parent.replace(/[\\/]+$/, "").toLowerCase() !== key);
    renderFoundBanner();
    toast("Game folder removed");
    renderSettings();
  } catch (e) {
    console.error("Remove game folder failed:", e);
    toast("Couldn't remove that folder");
  }
}

async function resetIgnoredFolders(path) {
  try {
    gameFolders = await invoke("reset_ignored_folders", { path });
    renderSettings();
    await checkGameFolders({ manual: true });
  } catch (e) {
    console.error("Reset ignored failed:", e);
  }
}

async function setFolderCheckPeriodic(enabled) {
  try {
    gameFolders = await invoke("set_game_folders_periodic", { enabled });
    renderSettings();
  } catch (e) {
    console.error("Couldn't save setting:", e);
  }
}

// ── Per-game three-dot menu ──────────────────────────────────────────────────
// `anchor` is the element the menu hangs under (the three-dot button), or a
// { x, y } point for a right-click.
function openGameMenu(game, anchor) {
  menuGame = game;
  const isFav = favorites.has(game.id);
  const hidden = hiddenGames.has(game.id);
  const isLocal = game.source === "Custom";
  menuEl.innerHTML = game.owned ? `
    <button data-mi="install">Install</button>
    <button data-mi="store">Open store page</button>
    <button data-mi="hide">${hidden ? "Unhide game" : "Hide game"}</button>
    <button data-mi="details">View details</button>
  ` : `
    <button data-mi="play">Play</button>
    ${!isLocal && storePageUrl(game) ? `<button data-mi="store">Open store page</button>` : ""}
    <button data-mi="favorite">${isFav ? "Remove from favorites" : "Add to favorites"}</button>
    <button data-mi="cover">Set cover image</button>
    <button data-mi="hide">${hidden ? "Unhide game" : "Hide game"}</button>
    <button data-mi="folder">${isLocal ? "Open game folder" : "Open install folder"}</button>
    <button data-mi="details">View details</button>
    ${isLocal ? `<button data-mi="remove" class="danger">Remove from library</button>` : ""}
  `;
  menuEl.style.left = "-9999px";
  menuEl.style.top = "0px";
  menuEl.classList.add("on");
  const mw = menuEl.offsetWidth;
  const mh = menuEl.offsetHeight;
  let x, y;
  if (anchor.getBoundingClientRect) {
    const r = anchor.getBoundingClientRect();
    x = r.right - mw;
    y = r.bottom + 6;
    if (y + mh > window.innerHeight - 8) y = r.top - mh - 6;
  } else {
    x = anchor.x;
    y = anchor.y;
    if (y + mh > window.innerHeight - 8) y = anchor.y - mh;
  }
  if (x < 8) x = 8;
  if (x + mw > window.innerWidth - 8) x = window.innerWidth - mw - 8;
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
    case "install": installOwnedGame(game); break;
    case "store": openStorePage(game); break;
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
    box.innerHTML = `<img src="${esc(v)}" alt="" data-dim-on-error>`;
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
      const game = findGame(menuBtn.dataset.menu);
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

    // Install buttons (owned games that aren't installed)
    const installBtn = e.target.closest("[data-install]");
    if (installBtn) {
      e.stopPropagation();
      const game = findGame(installBtn.dataset.install);
      if (game && game.owned) installOwnedGame(game);
      return;
    }

    // Play buttons
    const playBtn = e.target.closest("[data-play]");
    if (playBtn) {
      e.stopPropagation();
      const game = baseGames().find((g) => g.id === playBtn.dataset.play);
      if (game) launchGame(game);
      return;
    }

    // Trending: list tabs, cards, retry, store page
    const tl = e.target.closest("[data-tl]");
    if (tl) {
      trendList = tl.dataset.tl;
      trendInput = trendQuery = "";
      clearTimeout(trendSearchTimer);
      scrollEl.scrollTop = 0;
      renderTrending();
      return;
    }
    const tc = e.target.closest("[data-trend]");
    if (tc) {
      const t = findTrend(tc.dataset.trend);
      if (t) openTrendPanel(t);
      return;
    }
    if (e.target.id === "tretry") { loadTrend(trendKey()); renderTrendResults(); return; }
    if (e.target.closest("#tmorebtn")) { loadMoreTrend(); return; }
    if (e.target.closest("#tfbtn")) {
      trendFiltersOpen = !trendFiltersOpen;
      const box = $("#tfil");
      if (box) {
        box.hidden = !trendFiltersOpen;
        if (trendFiltersOpen) renderTrendPanel();
      }
      updateTrendHead();
      return;
    }
    if (e.target.closest("[data-tfclear]")) { clearTrendFilters(); return; }
    if (trendChipClick(e.target)) return;
    const addTag = e.target.closest("[data-addtag]");
    if (addTag) {
      const id = Number(addTag.dataset.addtag);
      trendFilters.exclude_tags = trendFilters.exclude_tags.filter((x) => x !== id);
      if (!trendFilters.tags.includes(id)) trendFilters.tags.push(id);
      closePanel();
      trendFiltersOpen = true;
      saveTrendFilters();
      scrollEl.scrollTop = 0;
      renderTrending();
      return;
    }
    if (e.target.id === "tstore" && trendSelected) {
      openExternal(`https://store.steampowered.com/app/${encodeURIComponent(trendSelected.app_id)}/`);
      return;
    }
    // Torrent source / site-search buttons in the panel's Torrents row
    const tlnk = e.target.closest("[data-turl]");
    if (tlnk) {
      openExternal(tlnk.dataset.turl);
      return;
    }

    // Sidebar nav
    const ri = e.target.closest(".ri");
    if (ri) {
      if (ri.dataset.pad !== undefined) { openPad(); return; }
      if (ri.dataset.pg) { currentPage = ri.dataset.pg; }
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
      const game = findGame(card.dataset.id);
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
    if (e.target.id === "dlg-browse") { browseExecutable(); return; }

    // Game folders
    if (e.target.id === "gf-add") { addGameFolder(); return; }
    if (e.target.id === "gf-check") { checkGameFolders({ manual: true }); return; }
    const gfRemove = e.target.closest("[data-gf-remove]");
    if (gfRemove) { removeGameFolder(gfRemove.dataset.gfRemove); return; }
    const gfReset = e.target.closest("[data-gf-reset]");
    if (gfReset) { e.preventDefault(); resetIgnoredFolders(gfReset.dataset.gfReset); return; }
    if (e.target.id === "found-review") { openFoundDialog(foundGames); return; }
    if (e.target.id === "found-later") { foundNotNow(); return; }
    if (e.target.id === "fnd-add") { addFoundGames(); return; }
    if (e.target.id === "fnd-ignore") { ignoreFoundGame(); return; }
    if (e.target.id === "fnd-later") { foundNotNow(); return; }
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
    if (e.target.id === "pstore" && selectedGame) { openStorePage(selectedGame); return; }
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
      if (tg.hasAttribute("data-gf-periodic")) {
        setFolderCheckPeriodic(tg.getAttribute("aria-pressed") !== "true");
        return;
      }
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

  // Right-click a game (card or list row) for its menu, at the pointer. The
  // keyboard's context-menu key reports no position, so hang it off the card.
  document.addEventListener("contextmenu", (e) => {
    // Trending cards have no menu; don't show the webview's own one either.
    if (e.target.closest("[data-trend]")) { e.preventDefault(); return; }
    const card = e.target.closest("[data-id]");
    if (!card || !scrollEl.contains(card)) return;
    const game = findGame(card.dataset.id);
    if (!game) return;
    e.preventDefault();
    const atPointer = e.clientX || e.clientY;
    openGameMenu(game, atPointer ? { x: e.clientX, y: e.clientY } : card);
  });

  // Dismiss the menu on scroll / resize
  scrollEl.addEventListener("scroll", () => { if (menuEl.classList.contains("on")) closeMenu(); }, true);
  scrollEl.addEventListener("scroll", () => { if (currentPage === "trend") queueTrendMore(); }, { passive: true });
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
  await loadGameFolders();
  renderAll();
  await loadOwnedGames();
  renderAll();
  // Show the saved library first; refresh it in the background if enabled.
  // With nothing saved yet there is nothing to show, so always scan then.
  if (isTauri && (settings.scan_on_startup || allGames.length === 0)) {
    await scanGames({ quiet: true });
  }
  // After the scan, so games a store just installed aren't offered as new.
  await checkGameFolders();
  setInterval(() => {
    if (gameFolders.check_periodically) checkGameFolders();
  }, FOLDER_CHECK_MS);
  // Show a popup that was held back while the window was hidden or in the background.
  window.addEventListener("focus", presentFoundGames);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) presentFoundGames(); });
}

init();
