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
let menuGame = null;   // game whose three-dot menu is open
let coverGame = null;  // game whose cover dialog is open
let coverPending = { value: null }; // staged cover (data URL) from a picked file
let settings = {
  scan_on_startup: true,
  track_playtime: true,
  keep_in_tray: false,
  hide_removed: false,
};
let storeConfig = {
  stores: { steam: true, epic: true, gog: true },
};

// Custom cover art, keyed by game id (persisted in IndexedDB, cached in memory
// so rendering stays synchronous).
const coverOverrides = new Map();
let coverDB = null;

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
const STORE_META = {
  Steam: { color: "#1b78b8" },
  Epic: { color: "#2a2a2a" },
  GOG: { color: "#a8541b" },
  Xbox: { color: "#107c10" },
  BattleNet: { color: "#00aeff" },
  Custom: { color: "#7a2f5e" },
};

const NAV = [["all", "All games"], ["recent", "Recently played"], ["fav", "Favorites"]];
const STORE_NAMES = ["Steam", "Epic", "GOG"];

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

function formatPlaytime(seconds) {
  const h = Math.floor((seconds || 0) / 3600);
  return h <= 0 ? "<1 h" : `${h} h`;
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

// Ordered list of cover URLs to try for a game: custom override first, then the
// store cover and (for Steam) progressively smaller fallbacks.
function coverCandidates(game) {
  const out = [];
  const override = coverOverrides.get(game.id);
  if (override) out.push(override);
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

function matchGame(game, filter) {
  if (filter === "all") return true;
  if (filter === "fav") return favorites.has(game.id);
  if (filter === "recent") {
    if (!game.last_played) return false;
    const d = new Date(game.last_played);
    const days = (Date.now() - d.getTime()) / 86400000;
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
  else if (sortBy === "hrs") games.sort((a, b) => (b.total_playtime_seconds || 0) - (a.total_playtime_seconds || 0));
  else if (sortBy === "recent") games.sort((a, b) => {
    if (!a.last_played) return 1;
    if (!b.last_played) return -1;
    return new Date(b.last_played) - new Date(a.last_played);
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

async function scanGames() {
  if (!isTauri) {
    toast("Tauri not available — running in browser mode");
    return;
  }
  scrollEl.innerHTML = `<div class="empty">Scanning your game library…</div>`;
  try {
    const result = await invoke("scan_all_games");
    console.log("[SCAN] Raw result:", result);
    if (result && Array.isArray(result)) {
      allGames = result;
      console.log("[SCAN] allGames set to", allGames.length, "games");
    } else {
      allGames = [];
    }
    renderAll();
    toast(`Found ${allGames.length} games`);
  } catch (e) {
    console.error("Scan failed:", e);
    scrollEl.innerHTML = `<div class="empty">Scan failed: ${e.message || e}. Check that Steam is installed.</div>`;
  }
}

async function launchGame(game) {
  if (!isTauri) {
    toast("Launching " + game.name + " (browser mode)");
    return;
  }
  try {
    await invoke("launch_game", { game });
    toast("Launching " + game.name);
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
  html += `<h4>Stores</h4>`;
  for (const s of STORE_NAMES) {
    const enabled = storeConfig.stores[s.toLowerCase()] !== false;
    if (enabled) {
      html += `<button class="ri ${currentPage === "lib" && currentFilter === s ? "on" : ""}" data-f="${s}">${s}<em>${cnt(s)}</em></button>`;
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
      <option value="hrs">Most played</option>
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
        <span>${esc(g.source)}, ${formatPlaytime(g.total_playtime_seconds)}${hiddenGames.has(g.id) ? " · hidden" : ""}</span>
      </button>`).join("") + `</div>`;
  } else {
    h = `<table class="tbl"><thead><tr><th></th><th>Name</th><th>Store</th><th class="r">Played</th><th>Last played</th><th class="r">Size</th><th></th><th></th></tr></thead><tbody>`
      + games.map((g) => `
        <tr data-id="${esc(g.id)}">
          <td>${renderThumb(g)}</td>
          <td>${esc(g.name)}</td>
          <td>${esc(g.source)}</td>
          <td class="r">${formatPlaytime(g.total_playtime_seconds)}</td>
          <td>${relativeTime(g.last_played)}</td>
          <td class="r">—</td>
          <td class="r"><button class="btn" data-play="${esc(g.id)}" style="padding:5px 14px">Play</button></td>
          <td class="r"><button class="dots-inline" data-menu="${esc(g.id)}" aria-label="Options for ${esc(g.name)}">&#8942;</button></td>
        </tr>`).join("") + `</tbody></table>`;
  }
  scrollEl.innerHTML = h;

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

  const srcRow = (name, key, desc, count) => {
    const on = enabledStores[key] !== false;
    return `<div class="src"><div><b><i class="dot ${on ? "" : "off"}"></i>${name}</b></div>
      <button class="tg ${on ? "on" : ""}" data-store="${key}" aria-pressed="${on}" aria-label="Toggle ${name}"></button>
      <span style="grid-column:1/-1">${desc}</span>
      <span style="grid-column:1/-1;color:var(--mute);font-size:12px">${on ? `${count} games found` : "Disabled — won't be scanned"}</span>
    </div>`;
  };

  const hiddenStores = Object.entries(enabledStores).filter(([, v]) => !v).map(([k]) => k);

  const hiddenSection = hiddenStores.length > 0
    ? `<h2>Hidden stores</h2>` +
      hiddenStores.map((k) => {
        const name = STORE_NAMES.find((s) => s.toLowerCase() === k) || k;
        return `<div class="src"><div><b>${name}</b></div>
          <button class="btn o" data-restore="${k}">Add back</button>
          <span style="grid-column:1/-1">This store is hidden. Click "Add back" to re-enable scanning.</span>
        </div>`;
      }).join("")
    : "";

  const tg = (key, n, d, v) => `<div class="src"><div><b>${n}</b></div><button class="tg" data-setting="${key}" aria-pressed="${v}" aria-label="${n}"></button><span style="grid-column:1/-1">${d}</span></div>`;

  scrollEl.innerHTML = `<div class="sec">
    <h2>Detected stores</h2>
    <div style="display:flex;align-items:center;justify-content:space-between"><span style="color:var(--mute)">Last scan: ${games.length} games total</span><button class="btn" id="rescan">Rescan now</button></div>
    ${srcRow("Steam", "steam", "C:\\Program Files (x86)\\Steam", games.filter((g) => g.source === "Steam").length)}
    ${srcRow("Epic Games", "epic", "C:\\Program Files\\Epic Games", games.filter((g) => g.source === "Epic").length)}
    ${srcRow("GOG Galaxy", "gog", "C:\\GOG Games", games.filter((g) => g.source === "GOG").length)}
    ${hiddenSection}
    <h2>Behavior</h2>
    ${tg("scan_on_startup", "Scan on startup", "Uses the saved library first, then refreshes in the background.", settings.scan_on_startup)}
    ${tg("track_playtime", "Track play time", "Notice when a game is running and count the session.", settings.track_playtime)}
    ${tg("keep_in_tray", "Keep running in the tray", "Closing the window doesn't quit Cabinet.", settings.keep_in_tray)}
    ${tg("hide_removed", "Hide games I've removed", "Trims uninstalled titles from store and collection views. They always stay visible under Uninstalled.", settings.hide_removed)}
  </div>`;

  const rb = $("#rescan");
  if (rb) rb.onclick = () => scanGames();

  document.querySelectorAll("[data-store]").forEach((el) => {
    el.addEventListener("click", () => {
      const key = el.dataset.store;
      const current = storeConfig.stores[key] !== false;
      storeConfig.stores[key] = !current;
      saveStoreConfig();
      renderSettings();
      renderRail();
      toast(current ? `${key} disabled` : `${key} enabled`);
    });
  });

  document.querySelectorAll("[data-restore]").forEach((el) => {
    el.addEventListener("click", () => {
      const key = el.dataset.restore;
      storeConfig.stores[key] = true;
      saveStoreConfig();
      renderSettings();
      renderRail();
      toast(`${key} re-enabled`);
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
    <p>${esc(game.source)}${game.description ? " — " + esc(game.description) : ""}${hidden ? " · hidden" : ""}</p>
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
      <dt>Played</dt><dd>${formatPlaytime(game.total_playtime_seconds)}</dd>
      <dt>Last played</dt><dd>${relativeTime(game.last_played)}</dd>
      <dt>Install size</dt><dd>—</dd>
      <dt>Location</dt><dd style="word-break:break-all">${esc(loc)}</dd>
    </dl>`;
  panelEl.classList.add("on");
  scrimEl.classList.add("on");
}

function closePanel() {
  panelEl.classList.remove("on");
  scrimEl.classList.remove("on");
  dlgEl.classList.remove("on");
  covDlgEl.classList.remove("on");
  selectedGame = null;
}

// ── Add game dialog ──────────────────────────────────────────────────────────
function openDialog() {
  dlgEl.classList.add("on");
  scrimEl.classList.add("on");
}

function closeDialog() {
  dlgEl.classList.remove("on");
  if (!panelEl.classList.contains("on")) scrimEl.classList.remove("on");
}

function addGameFromDialog() {
  const exe = $("#dlg-exe").value.trim();
  const name = $("#dlg-name").value.trim();
  const args = $("#dlg-args").value.trim();
  if (!exe || !name) { toast("Please fill in executable and name"); return; }
  const game = {
    id: "custom-" + Date.now(),
    name,
    description: null,
    install_path: exe.replace(/[^\\/]+$/, ""),
    executable_path: exe,
    launch_command: args ? exe + " " + args : exe,
    cover_image_path: null,
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

// ── Controller mode ──────────────────────────────────────────────────────────
function openPad() {
  const games = baseGames();
  if (!games.length) { toast("No games to display"); return; }
  controllerIndex = 0;
  padEl.classList.add("on");
  renderPad();
}

function closePad() {
  padEl.classList.remove("on");
}

function renderPad() {
  const games = baseGames();
  if (!games.length) { closePad(); return; }
  const g = games[controllerIndex];
  $("#prow").innerHTML = games.map((game, i) =>
    `<div class="it ${i === controllerIndex ? "f" : ""}">${renderCover(game)}</div>`
  ).join("");
  $("#pinfo").innerHTML = `<h2>${esc(g.name)}</h2><p>${esc(g.source)}, ${formatPlaytime(g.total_playtime_seconds)} played, last ${relativeTime(g.last_played).toLowerCase()}</p>`;
  $("#pc").textContent = (controllerIndex + 1) + " of " + games.length;
  const f = $("#prow .f");
  if (f) f.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
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

    // Panel actions
    if (e.target.id === "fv" && selectedGame) { toggleFavorite(selectedGame.id); openPanel(selectedGame); return; }
    if (e.target.id === "pcov" && selectedGame) { openCoverDialog(selectedGame); return; }
    if (e.target.id === "phide" && selectedGame) { toggleHidden(selectedGame.id); openPanel(selectedGame); return; }

    // Cover dialog actions
    if (e.target.id === "cov-file") { $("#cov-input").click(); return; }
    if (e.target.id === "cov-search") { searchCoverFor(coverGame); return; }
    if (e.target.id === "cov-reset") { resetCover(); return; }
    if (e.target.id === "cov-save") { saveCover(); return; }

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
      const games = baseGames();
      if (e.key === "ArrowRight") { controllerIndex = Math.min(games.length - 1, controllerIndex + 1); renderPad(); }
      else if (e.key === "ArrowLeft") { controllerIndex = Math.max(0, controllerIndex - 1); renderPad(); }
      else if (e.key === "Enter" || e.key.toLowerCase() === "a") {
        const g = games[controllerIndex];
        if (g) launchGame(g);
      }
      else if (e.key === "y") {
        const g = games[controllerIndex];
        if (g) { toggleFavorite(g.id); renderPad(); }
      }
      else if (e.key === "Escape" || e.key.toLowerCase() === "b") { closePad(); }
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
  loadHiddenGames();
  setupEventListeners();
  await loadCoverOverrides();
  await loadFavorites();
  await loadCachedGames();
  await loadStoreConfig();
  renderAll();
  if (isTauri) await scanGames();
}

init();
