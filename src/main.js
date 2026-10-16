import { invoke } from "@tauri-apps/api/core";

// ── State ────────────────────────────────────────────────────────────────────
let allGames = [];
let customGames = [];
let currentFilter = "all";
let currentView = "grid";
let searchQuery = "";
let sortBy = "recent";
let favorites = new Set();
let selectedGame = null;
let currentPage = "lib"; // "lib" | "set"
let controllerIndex = 0;
let gameStatuses = {}; // game_id → "backlog" | "playing" | "finished"
let settings = {
  scan_on_startup: true,
  track_playtime: true,
  keep_in_tray: false,
  hide_removed: false,
};
let storeConfig = {
  stores: { steam: true, epic: true, gog: true },
};

// ── DOM refs ─────────────────────────────────────────────────────────────────
const $ = (s) => document.querySelector(s);
const railEl = $("#rail");
const topEl = $("#top");
const scrollEl = $("#sc");
const scrimEl = $("#scrim");
const panelEl = $("#panel");
const dlgEl = $("#dlg");
const padEl = $("#pad");

const isTauri = typeof window !== "undefined" && (
  window.__TAURI__ !== undefined ||
  window.__TAURI_INTERNALS__ !== undefined ||
  (window.__TAURI_METADATA__ !== undefined)
);

// ── Store metadata ───────────────────────────────────────────────────────────
const STORE_META = {
  Steam: { color: "#1b78b8", icon: "S" },
  Epic: { color: "#2a2a2a", icon: "E" },
  GOG: { color: "#a8541b", icon: "G" },
  Xbox: { color: "#107c10", icon: "X" },
  BattleNet: { color: "#00aeff", icon: "B" },
  Custom: { color: "#7a2f5e", icon: "+" },
};

const NAV = [["all", "All games"], ["recent", "Recently played"], ["fav", "Favorites"]];
const STORE_NAMES = ["Steam", "Epic", "GOG"];

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

function renderCover(game, extra = "") {
  const url = game.cover_image_path;
  const name = game.name || "?";
  if (url) {
    return `<div class="cv ${extra}" style="background:#222">
      <img src="${url}" alt="${name}" loading="lazy"
           onerror="this.remove()">
      <span style="position:relative;mix-blend-mode:normal;text-shadow:0 1px 8px #0006;color:#fff">${name}</span>
    </div>`;
  }
  const { background, color } = getCoverGradient(name);
  return `<div class="cv ${extra}" style="background:${background};color:${color}">
    <span style="position:relative;mix-blend-mode:normal;text-shadow:0 1px 8px #0006">${name}</span>
  </div>`;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
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

function getDisplayGames() {
  let games = [...allGames, ...customGames];
  if (settings.hide_removed) games = games.filter((g) => g.is_installed !== false);
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

// ── Persistence ──────────────────────────────────────────────────────────────
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
    if (cached && cached.length > 0) {
      allGames = cached;
    }
  } catch { /* ignore */ }
}

async function loadStoreConfig() {
  if (!isTauri) {
    // Browser mode: load from localStorage
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
    console.log("[SCAN] Type:", typeof result, "Is array:", Array.isArray(result), "Length:", result?.length);
    if (result && Array.isArray(result)) {
      allGames = result;
      console.log("[SCAN] allGames set to", allGames.length, "games");
      console.log("[SCAN] Sources:", allGames.map(g => g.source));
    } else {
      allGames = [];
      console.log("[SCAN] Result not array, set to empty");
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
    // Browser mode: toggle locally
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

// ── Rendering ────────────────────────────────────────────────────────────────
function renderRail() {
  const games = getDisplayGames();
  const cnt = (f) => games.filter((g) => matchGame(g, f)).length;
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
  const titles = { all: "All games", recent: "Recently played", fav: "Favorites", local: "Local Games" };
  const t = titles[currentFilter] || currentFilter;
  const games = getFilteredGames();
  topEl.innerHTML = `<h1>${t}</h1><span class="n">${games.length}</span>
    <input class="q" id="q" placeholder="Search games" value="${searchQuery.replace(/"/g, "&quot;")}" aria-label="Search games">
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
  console.log("[RENDER] allGames:", allGames.length, "filtered:", games.length, "filter:", currentFilter, "view:", currentView);
  console.log("[RENDER] Games:", games.map(g => ({ id: g.id, name: g.name, source: g.source })));
  let h;
  if (!games.length) {
    h = `<div class="empty">No games match "${searchQuery}". Check the spelling, or add it manually.</div>`;
  } else if (currentView === "grid") {
    h = `<div class="grid">` + games.map((g) => {
      const isFav = favorites.has(g.id);
      return `<button class="g" data-id="${g.id}">
        ${renderCover(g, "")}<span class="play" data-play="${g.id}">Play</span>
        <b>${g.name}</b>
        <span>${g.source}, ${formatPlaytime(g.total_playtime_seconds)}</span>
      </button>`;
    }).join("") + `</div>`;
  } else {
    h = `<table class="tbl"><thead><tr><th></th><th>Store</th><th class="r">Played</th><th>Last played</th><th class="r">Size</th><th></th></tr></thead><tbody>`
      + games.map((g) => {
        const { background } = getCoverGradient(g.name);
        return `<tr data-id="${g.id}">
          <td><span class="th" style="background:${background}"></span></td>
          <td>${g.name}</td>
          <td>${g.source}</td>
          <td class="r">${formatPlaytime(g.total_playtime_seconds)}</td>
          <td>${relativeTime(g.last_played)}</td>
          <td class="r">—</td>
          <td class="r"><button class="btn" data-play="${g.id}" style="padding:5px 14px">Play</button></td>
        </tr>`;
      }).join("") + `</tbody></table>`;
  }
  scrollEl.innerHTML = h;

  // Restore search focus
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
  const games = getDisplayGames();
  const enabledStores = storeConfig.stores;

  const srcRow = (name, key, desc, count) => {
    const on = enabledStores[key] !== false;
    return `<div class="src"><div><b><i class="dot ${on ? "" : "off"}"></i>${name}</b></div>
      <button class="tg ${on ? "on" : ""}" data-store="${key}" aria-pressed="${on}" aria-label="Toggle ${name}"></button>
      <span style="grid-column:1/-1">${desc}</span>
      <span style="grid-column:1/-1;color:var(--mute);font-size:12px">${on ? `${count} games found` : "Disabled — won't be scanned"}</span>
    </div>`;
  };

  const hiddenStores = Object.entries(enabledStores)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  const hiddenSection = hiddenStores.length > 0
    ? `<h2>Hidden stores</h2>` +
      hiddenStores.map((k) => {
        const name = STORE_NAMES.find(s => s.toLowerCase() === k) || k;
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
    ${srcRow("Steam", "steam", "C:\\Program Files (x86)\\Steam", games.filter(g => g.source === "Steam").length)}
    ${srcRow("Epic Games", "epic", "C:\\Program Files\\Epic Games", games.filter(g => g.source === "Epic").length)}
    ${srcRow("GOG Galaxy", "gog", "C:\\GOG Games", games.filter(g => g.source === "GOG").length)}
    ${hiddenSection}
    <h2>Behavior</h2>
    ${tg("scan_on_startup", "Scan on startup", "Uses the saved library first, then refreshes in the background.", settings.scan_on_startup)}
    ${tg("track_playtime", "Track play time", "Notice when a game is running and count the session.", settings.track_playtime)}
    ${tg("keep_in_tray", "Keep running in the tray", "Closing the window doesn't quit Cabinet.", settings.keep_in_tray)}
    ${tg("hide_removed", "Hide games I've removed", "Keep uninstalled titles out of the library.", settings.hide_removed)}
  </div>`;

  const rb = $("#rescan");
  if (rb) rb.onclick = () => scanGames();

  // Store toggle handlers
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

  // Restore store handlers
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
  const status = gameStatuses[game.id] || "playing";
  const loc = game.source === "Steam"
    ? "C:\\Program Files (x86)\\Steam\\steamapps\\common\\" + game.name
    : (game.install_path || "D:\\Games\\" + game.name);

  panelEl.innerHTML = `<button class="x" id="px" aria-label="Close">&times;</button>
    ${renderCover(game)}
    <h2>${game.name}</h2>
    <p>${game.source}${game.description ? " — " + game.description : ""}</p>
    <div class="acts">
      <button class="btn" data-play="${game.id}">Play</button>
      <button class="btn o" id="fv">${isFav ? "Remove favorite" : "Favorite"}</button>
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
      <dt>Location</dt><dd style="word-break:break-all">${loc}</dd>
      <dt>Sessions</dt><dd>${game.last_played ? relativeTime(game.last_played) + ", " + formatPlaytime(game.total_playtime_seconds) : "No sessions yet"}</dd>
    </dl>`;
  panelEl.classList.add("on");
  scrimEl.classList.add("on");
}

function closePanel() {
  panelEl.classList.remove("on");
  scrimEl.classList.remove("on");
  dlgEl.classList.remove("on");
  selectedGame = null;
}

// ── Add game dialog ──────────────────────────────────────────────────────────
function openDialog() {
  dlgEl.classList.add("on");
  scrimEl.classList.add("on");
}

function closeDialog() {
  dlgEl.classList.remove("on");
  scrimEl.classList.remove("on");
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

// ── Controller mode ──────────────────────────────────────────────────────────
function openPad() {
  const games = getDisplayGames();
  if (!games.length) { toast("No games to display"); return; }
  controllerIndex = 0;
  padEl.classList.add("on");
  renderPad();
}

function closePad() {
  padEl.classList.remove("on");
}

function renderPad() {
  const games = getDisplayGames();
  if (!games.length) { closePad(); return; }
  const g = games[controllerIndex];
  $("#prow").innerHTML = games.map((game, i) =>
    `<div class="it ${i === controllerIndex ? "f" : ""}">${renderCover(game)}</div>`
  ).join("");
  $("#pinfo").innerHTML = `<h2>${g.name}</h2><p>${g.source}, ${formatPlaytime(g.total_playtime_seconds)} played, last ${relativeTime(g.last_played).toLowerCase()}</p>`;
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
  setTimeout(() => t.remove(), 1600);
}

// ── Events ───────────────────────────────────────────────────────────────────
function setupEventListeners() {
  document.addEventListener("click", (e) => {
    // Play buttons
    const playBtn = e.target.closest("[data-play]");
    if (playBtn) {
      e.stopPropagation();
      const id = playBtn.dataset.play;
      const game = getDisplayGames().find((g) => g.id === id);
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
      const game = getDisplayGames().find((g) => g.id === card.dataset.id);
      if (game) openPanel(game);
      return;
    }

    // Close panel / dialog
    if (e.target.closest("#px") || e.target.id === "scrim" || e.target.id === "dx") { closePanel(); return; }

    // Add game
    if (e.target.id === "add") { openDialog(); return; }

    // Add game confirm
    if (e.target.id === "dok") { addGameFromDialog(); return; }

    // Browse button
    if (e.target.id === "dlg-browse") { $("#dlg-file").click(); return; }

    // Favorite toggle in panel
    if (e.target.id === "fv" && selectedGame) {
      toggleFavorite(selectedGame.id);
      openPanel(selectedGame);
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
      if (tg.dataset.store) return; // handled by the store toggle listener
      const key = tg.dataset.setting;
      if (!key) return;
      settings[key] = !(tg.getAttribute("aria-pressed") === "true");
      saveSettings();
      renderAll();
      return;
    }
  });

  // File input for browse
  const fileInput = $("#dlg-file");
  if (fileInput) {
    fileInput.addEventListener("change", (e) => {
      const f = e.target.files[0];
      if (f) $("#dlg-exe").value = f.path || f.name;
    });
  }

  // Keyboard
  document.addEventListener("keydown", (e) => {
    if (padEl.classList.contains("on")) {
      const games = getDisplayGames();
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
      closePanel();
    }
  });
}

// ── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  loadSettings();
  loadCustomGames();
  loadGameStatuses();
  setupEventListeners();
  await loadFavorites();
  await loadCachedGames();
  await loadStoreConfig();
  renderAll();
  if (isTauri) await scanGames();
}

init();
