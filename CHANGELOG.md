# Game Launcher — Development Log

## Project Info
- **Stack:** Rust + Tauri (backend), HTML/CSS/JS (frontend)
- **Build location:** `C:\Users\91623\code\GAMELAUCNHER\src-tauri` (NOT Desktop — file-lock issues)
- **Working dir (Desktop copy):** `C:\Users\91623\Desktop\code\GAMELAUCNHER` (causes build failures due to file locks)

---

## Environment Setup

### MSVC Linker (resolved)
- Installed Visual Studio Build Tools with C++ workload
- Provides `link.exe` needed by Rust on Windows

### Build-File Lock Issue
- **Symptom:** `The process cannot access the file because it is being used by another process (os error 32)`
- **Cause:** Desktop folder locks files (likely OneDrive.Sync.Service or Windows Defender)
- **Fix:** Build from `C:\Users\91623\code\GAMELAUCNHER` instead of Desktop

---

## Phase 1 — MVP (Completed)

### Backend Changes
| File | Change |
|---|---|
| `src-tauri/src/lib.rs` | Added `.manage(Mutex::new(AppState { cache_dir }))` — fixed "state not managed" Tauri error |
| `src-tauri/src/scanners/epic.rs` | Changed `parse_manifest` to accept `&Path` instead of `&PathBuf`, added `Path` import |
| `src-tauri/src/scanners/gog.rs` | Fixed `game_path.to_string_lossy().to_string()` → `game_path.clone()` |
| `src-tauri/icons/icon.ico` | Created valid icon file (was missing, caused build failure) |

### Frontend Changes
| File | Change |
|---|---|
| `src/main.js` | Initial scan, render grid/list, launch, search, cache |
| `src/styles/main.css` | Dark theme, sidebar, grid/list views, loading states |
| `index.html` | Basic layout with sidebar + games container |

### Tauri Commands Available
- `scan_all_games` — Scan all platforms
- `get_cached_games` — Load cached results
- `launch_game` — Launch a game
- `rescan_platform` — Rescan single platform

---

## Phase 2 — Polish (Completed)

### Backend Changes
| File | Change |
|---|---|
| `src-tauri/src/services/cache.rs` | Added `load_favorites()` and `save_favorites()` for persistent favorites |
| `src-tauri/src/commands/mod.rs` | Added `toggle_favorite`, `get_favorites`, `get_game_details` commands |
| `src-tauri/src/lib.rs` | Registered 3 new commands in invoke handler |
| `src-tauri/src/scanners/steam.rs` | Deduplication via HashSet, Steam CDN cover image URLs |

### Frontend Changes
| File | Change |
|---|---|
| `src/main.js` | Category filtering (All/Recent/Favorites/A-Z), platform filtering, favorites (star button), game details panel (slide-in), better cover art fallbacks with per-platform colors |
| `src/styles/main.css` | `.fav-btn` styles (hover-only visibility), `.details-panel` with slide-in animation, `.nav-section-title` |
| `index.html` | Library section (category tabs) + Platforms section, `<div id="details-panel">` |

### New Tauri Commands
- `toggle_favorite(game_id)` — Toggle favorite status
- `get_favorites()` — Get all favorite game IDs
- `get_game_details(game_id)` — Get full game details

### Phase 2 Features
| Feature | Status |
|---|---|
| Cover art loading (Steam CDN) | ✅ Fixed |
| Categories (All, Recent, Favorites, A-Z) | ✅ Working |
| Dark theme | ✅ Working |
| Game details panel | ✅ Working |
| Playtime tracking | ⏭️ Skipped per user request (UI fully removed in Phase 5) |

---

## Build & Run

### Debug Build (requires frontend dev server)
```powershell
# Terminal 1 — Frontend
cd C:\Users\91623\code\GAMELAUCNHER
npm install
npm run dev

# Terminal 2 — Backend
cd C:\Users\91623\code\GAMELAUCNHER\src-tauri
cargo build
.\target\debug\game-launcher.exe
```

### Release Build (standalone exe)
```powershell
cd C:\Users\91623\code\GAMELAUCNHER
npm run build
cd src-tauri
cargo build --release
# Exe at: target\release\game-launcher.exe
```

### Clean Build
```powershell
cd C:\Users\91623\code\GAMELAUCNHER\src-tauri
cargo clean
cargo build
```

---

## Phase 3 — Cabinet Design Redesign (Paused → Resumed)

### Overview
Complete frontend redesign following the "Cabinet: Game Launcher" design specification. Phase 3 was paused to prioritize implementing the new design correctly. All features from the design have been implemented.

### Folder Structure Changes
| File | Change |
|---|---|
| `src-tauri/assets/design/Cabinet_ Game Launcher.html` | Moved to `src/assets/design/` — design is a frontend asset, not Tauri-specific |

### New Folder Structure
```
game-launcher/
├── src/
│   ├── main.js                  # Complete rewrite — Cabinet design logic
│   ├── styles/
│   │   └── main.css             # Complete rewrite — Cabinet design styles
│   └── assets/
│       └── design/
│           └── Cabinet_ Game Launcher.html  # Design reference (moved from src-tauri)
├── src-tauri/
│   ├── src/                     # Rust backend (unchanged)
│   └── ...
├── index.html                   # Complete rewrite — Cabinet layout
└── CHANGELOG.md                 # This file
```

### Design Implementation Details

#### Visual Design
| Feature | Status |
|---|---|
| Typography (Schibsted Grotesk, 800 weight headings) | ✅ Implemented |
| Color palette (#151719 bg, #101214 rail, #e8e5de text) | ✅ Exact match |
| 34px title bar with window controls | ✅ Implemented |
| 200px sidebar with sections (Library/Stores/App) | ✅ Implemented |
| Top bar with title, count, search, sort, view toggle, add game | ✅ Implemented |
| 2:3 aspect ratio covers | ✅ Implemented |
| Gradient cover generation (5 patterns, 12 color palettes) | ✅ Implemented |
| Responsive layout (760px breakpoint) | ✅ Implemented |

#### Grid View
| Feature | Status |
|---|---|
| Auto-fill grid (minmax 150px, 1fr) | ✅ Implemented |
| Cover with gradient background + title overlay | ✅ Implemented |
| Play button on hover (top-right) | ✅ Implemented |
| Game name + source/hours below cover | ✅ Implemented |
| Favorite button on hover | ✅ Implemented |

#### List View
| Feature | Status |
|---|---|
| Table with thumbnail, title, store, last played, size | ✅ Implemented (real cover thumbs; *Played* column dropped in Phase 5; size is measured on disk) |
| Small gradient thumbnails (30x44) | ✅ Implemented |
| Play button per row | ✅ Implemented |
| Hover highlight | ✅ Implemented |

#### Details Panel
| Feature | Status |
|---|---|
| Slide-in panel from right (min 440px, 100%) | ✅ Implemented |
| Large cover with game info | ✅ Implemented |
| Play + Favorite buttons | ✅ Implemented |
| Status segmented control (Backlog/Playing/Finished) | ✅ Implemented |
| Details grid (Last played, Install size, Location) | ✅ Implemented (real on-disk size in Phase 5; *Played* row dropped) |
| Persistent game statuses (localStorage) | ✅ Implemented |

#### Settings Page
| Feature | Status |
|---|---|
| Detected stores section with status dots | ✅ Implemented |
| Store game counts from real scan data | ✅ Implemented |
| Other launchers section | ✅ Implemented |
| Behavior toggles (4 settings) | ✅ Implemented |
| Toggles persist to localStorage | ✅ Implemented |
| Rescan now button | ✅ Implemented |

#### Controller Mode
| Feature | Status |
|---|---|
| Full-screen overlay | ✅ Implemented |
| Horizontal carousel of covers | ✅ Implemented |
| Focused cover highlight (larger, glow) | ✅ Implemented |
| Game info at bottom | ✅ Implemented |
| Keyboard navigation (Arrow keys, Enter, Escape) | ✅ Implemented |
| Controller key hints (A=Play, B=Back, Y=Favorite) | ✅ Implemented |

#### Add Game Dialog
| Feature | Status |
|---|---|
| Modal dialog with backdrop | ✅ Implemented |
| Executable path + Browse button | ✅ Implemented |
| Name field | ✅ Implemented |
| Launch arguments field | ✅ Implemented |
| Custom games persist to localStorage | ✅ Implemented |
| Custom games appear in library | ✅ Implemented |

#### Other Features
| Feature | Status |
|---|---|
| Toast notifications | ✅ Implemented |
| Search with focus preservation | ✅ Implemented |
| Sort (Recently played, A-Z) | ✅ Implemented (*Most played* dropped in Phase 5) |
| Category filtering with counts | ✅ Implemented |
| Platform filtering | ✅ Implemented |
| Favorites (Tauri backend + browser fallback) | ✅ Implemented |
| Game launching (Tauri backend + browser fallback) | ✅ Implemented |
| Cached games loading | ✅ Implemented |
| Real cover images (Steam CDN) with gradient fallback | ✅ Implemented |
| Relative time display (Today, Yesterday, N days ago) | ✅ Implemented |
| Hide uninstalled games toggle | ✅ Implemented |

### Backend Integration
- All existing Tauri commands preserved: `scan_all_games`, `get_cached_games`, `launch_game`, `toggle_favorite`, `get_favorites`
- Browser mode: graceful fallback with localStorage for favorites, custom games, settings, and statuses
- No backend changes required

---

## Phase 3 (cont.) — Bug Fixes & Polish (Oct 14, 2026)

### Fixes (Oct 14, 2026)

| Issue | Fix |
|---|---|
| **Tauri detection failing** — `window.__TAURI__` not always set in Tauri v2 | Updated `isTauri` check to also test `__TAURI_INTERNALS__` and `__TAURI_METADATA__` |
| **Steam games not showing** — `hide_removed` default was `true`, filtering out uninstalled games | Changed default to `false` so all scanned games appear |
| **Only Epic game visible** — caused by `hide_removed` filtering + cache having stale data | Fixed by the above; added diagnostic logging (`[SCAN]` / `[RENDER]` console logs) |
| **Fake title bar** — user wanted native OS title bar only | Removed `.tb` from HTML and CSS; set `"decorations": true` in tauri.conf.json |
| **Scan error not visible** — errors were silent | Added toast + inline error message showing actual error text |
| **Self-referencing bug** in `getFilteredGames()` | Removed erroneous `let games = getFilteredGames` line |

### Changes
- Removed fake in-app title bar (native OS title bar used instead)
- Added diagnostic console logging for scan and render pipeline
- `hide_removed` setting now defaults to `false`
- `decorations: true` in tauri.conf.json (native title bar with min/max/close)

### Diagnostic Logs (for debugging)
Open DevTools (F12) → Console to see:
- `[SCAN] allGames set to N games` — backend scan results
- `[SCAN] Sources: ["Steam", ...]` — detected sources
- `[RENDER] allGames: N filtered: M` — filter pipeline output

---

## Phase 4 — Stores, Local Games & Custom Artwork (Oct 15–16, 2026)

### Backend Changes
| File | Change |
|---|---|
| `src-tauri/src/models/store_config.rs` | **New** — `StoreConfig` (`stores: HashMap<String, bool>`), persisted to `store_config.json` |
| `src-tauri/src/commands/mod.rs` | Added `get_store_config` / `set_store_config`, `open_url`, `open_game_folder` |
| `src-tauri/src/services/aggregator.rs` | Added `scan_enabled()` and `scan_platform()` so only enabled stores get scanned |
| `src-tauri/src/lib.rs` | Registered the new commands |
| `scripts/generate-icons.mjs` | **New** — builds the app icon set (cabinet + gamepad mark) and per-store PNGs via `sharp` |
| `src-tauri/icons/*` | Regenerated — multi-size `icon.ico`, `icon.icns`, plus `store-*.png` |

### Bug Fixes
| Issue | Fix |
|---|---|
| **Steam games never appeared** | Scanner looked in `<library>\common\<installdir>`; the real path is `<library>\steamapps\common\<installdir>`, so `is_installed` was always `false`. Now derived from the manifest's parent directory. |
| **Settings toggles toggled each other** | Behavior and store toggles both used `.tg`. Behavior toggles now carry `data-setting` and the click handler checks it. |

### Frontend Changes
- **Stores can be hidden, never deleted.** Disabling a store moves it to a *Hidden stores* section in Sources with an **Add back** button.
- **Local Games** collection: add games that aren't in any store library (executable, name, launch args) via a modal dialog; stored in `localStorage`.
- **Custom cover art** for *any* game (store or local): file → canvas-downscale to ≤600×900, or paste a URL. Stored in IndexedDB (`cabinet` → `covers`) and cached in an in-memory map so rendering stays synchronous.
- **Hide game** from the three-dot menu; hidden games are filtered everywhere except the new *Hidden* collection, so hiding is always reversible.
- **Never lose a title:** *All games* and *Uninstalled* always show the full set; `hide_removed` only trims scoped views.
- **Per-game three-dot menu:** Play, favorites, Set cover image, Hide/Unhide, Open install folder, View details, Remove (local games only).
- **Better cover sources:** Steam `library_600x900.jpg` (600×900, matches the 2:3 grid) with a `capsule_616x353 → header → gradient` fallback chain; Epic uses `VaultThumbnailUrl`.
- **UI polish:** real cover images in list view, three-dot moved into the title row (right-aligned, always visible), game name no longer overlaid on real cover art, details panel made responsive (actions wrap; ≤560px and ≤400px breakpoints).

---

## Phase 5 — Name-based Covers, Real Sizes & Wider Store Support (Oct 16, 2026)

### Backend Changes
| File | Change |
|---|---|
| `src-tauri/src/commands/mod.rs` | **New** `search_steam_covers`, `get_game_size`, `detect_stores` |
| `src-tauri/src/models/mod.rs` | **New** `CoverSuggestion`, `DetectedStore` |
| `src-tauri/Cargo.toml` | Added `reqwest` (already in the dep tree) with **`native-tls`**, not the default rustls stack |

- **`search_steam_covers(name)`** — looks a game up on the Steam store by name so Epic/GOG/local titles can borrow Steam's 600×900 art. Important detail: it then **HEAD-checks each candidate's `library_600x900.jpg` in parallel and only returns entries whose art actually exists**. The top search hit is usually a DLC, sequel or demo with no portrait art (e.g. "Control" → *CONTROL Resonant* = no art, *CONTROL Ultimate Edition* = 200 OK).
- **`get_game_size(path)`** — walks the install folder with `walkdir` and returns the exact sum of file sizes. Runs via `spawn_blocking` so the UI thread is never held up.
- **`detect_stores()`** — reports which common launchers are present (Steam, Epic, GOG, Battle.net, Ubisoft Connect, EA App, Xbox, Amazon Games, itch.io, Rockstar) using registry keys and well-known install paths.
- **Dependency note:** reqwest's default features pulled in 47 extra crates including `aws-lc-sys` (requires cmake) and QUIC. Switched to `native-tls` (Windows schannel) — now 19 crates, no C toolchain needed.

### Frontend Changes
- **Epic/GOG covers fixed.** Games are looked up by name once, cached in `localStorage`, and filled in progressively; a store's own art is the fallback. The lookup runs sequentially in the background so startup is never blocked.
- **Artwork suggestions while adding games.** The Add-game dialog searches as you type (700 ms debounce) and shows clickable 2:3 thumbnails; the Change-cover dialog got the same *Find artwork* button, so any game can be re-covered.
- **Real install size on disk.** Measured lazily — one game at a time, only for rows currently in view (IntersectionObserver) or the details panel you opened. Games that can't be measured show `—` instead of a made-up number.
- **Play-time tracking removed entirely** (per user request): the setting, the list *Played* column, the *Most played* sort, the card meta text and the panel row are all gone — it was never actually recorded anyway.
- **Stores in the sidebar are optional.** New *Show stores in the sidebar* behavior toggle; the group now only appears when it actually has games.
- **Sources checks 10 launchers** with install detection, a status dot and a per-store toggle. Launchers that can't be scanned yet are labelled honestly rather than showing a fake game count.

---

## Phase 6 — Bug Sweep, Tray Mode & Gamepad (Nov 19, 2026)

### Backend Changes
| File | Change |
|---|---|
| `src-tauri/src/lib.rs` | Data now lives in `app_data_dir()` (`%APPDATA%\com.gamelauncher.app`); state is managed inside `setup` |
| `src-tauri/src/services/cache.rs` | Writes create the folder first (`write_file`) |
| `src-tauri/src/services/launcher.rs` | Protocol links go through a new `shell_open` (no `cmd`); launch arguments are passed; working dir guarded |
| `src-tauri/src/commands/mod.rs` | `scan_all_games` / `rescan_platform` are async (`spawn_blocking`); `rescan_platform` merges; `open_url` uses `shell_open` |
| `src-tauri/src/scanners/steam.rs` | Reads `LastPlayed`; skips Steamworks Common Redistributables (228980) |
| `src-tauri/src/scanners/epic.rs` | Launches via `com.epicgames.launcher://apps/<ns>%3A<item>%3A<app>?action=launch&silent=true`; skips DLC/add-ons |
| `src-tauri/src/scanners/gog.rs` | Uses the registry's `exe` / `launchParam` when present (exe guessing kept as fallback) |
| `src-tauri/src/tray.rs` | **New** — tray icon (Show / Quit), hide-on-close, `set_keep_in_tray` command |
| `src-tauri/Cargo.toml` | Added `tray-icon` feature; removed unused `tokio`, `dirs`, `sysinfo` |

### Bug Fixes
| Issue | Fix |
|---|---|
| **Favorites / scan cache / store config never persisted** — state pointed at `%TEMP%\game-launcher`, which nothing created, and `fs::write` doesn't create folders. The cache save error was discarded, so the saved library was always empty; toggling a favorite failed (logged to console only) until a store toggle happened to create the folder. | Moved to the app data dir and made every write create its folder. Old data in `%TEMP%` is not migrated (none existed on the dev machine). |
| **"Recently played" always empty, default sort a no-op** — every scanner set `last_played: None` | Steam's `LastPlayed` is parsed; the frontend also records launches from Cabinet (`cabinet_last_launched`), so Epic/GOG/local games count too |
| **Custom-game launch arguments ignored** — stored in `launch_command`, but only `executable_path` was run | Arguments = what follows the exe in `launch_command`, passed verbatim (`raw_arg`). Works for games saved by earlier versions. |
| **"Search the web" lost its query** — `cmd /C start` treats `&` as a command separator | `shell_open` uses `rundll32 url.dll,FileProtocolHandler`; Steam and Epic links go the same way |
| **Epic games started from the exe**, skipping the launcher's login | Launch through the Epic launcher link |
| **Window froze during a scan** — sync Tauri commands run on the main thread | Scans run on the blocking pool |
| **`rescan_platform` wiped other stores from the cache** | Merges by id prefix |
| **"Scan on startup" did nothing; startup scan replaced the saved library with "Scanning…"** | Setting respected (always scans if nothing is saved); startup refresh is quiet and keeps the list on screen |
| **"Keep running in the tray" did nothing** | Implemented (`tray.rs`); the tray icon only appears while the setting is on |
| **Controller mode was keyboard-only and showed hidden games** | Gamepad support (A/B/Y, d-pad / left stick with repeat); hidden games excluded |

---

## Known Issues
- **Launchers other than Steam/Epic/GOG are detected but not scanned** — Battle.net, Ubisoft, EA, Xbox, Amazon, itch.io and Rockstar appear in Sources with install status, but no games are read from them yet.
- **Games not on Steam get no artwork** — the name lookup can only find titles that also exist on Steam; everything else falls back to the store thumbnail or a gradient tile.
- **Cover lookups are cached permanently** — if a game later appears on Steam it won't be re-looked-up. Clearing `cabinet_cover_lookup` from localStorage forces a retry.
- **Sizes are recomputed each launch** — they're exact but not cached between sessions, so a large game is re-walked the first time you open it.
- **Desktop folder builds fail** with file-lock errors — always build from `C:\Users\91623\code\GAMELAUCNHER`.
- **Git remote contains a plaintext PAT** in `.git/config` (and `.env.local`) — should be revoked and replaced with a credential helper.
- **GOG changes are untested** — no GOG install on the dev machine; registry value names (`exe`, `launchParam`) follow GOG's documented layout.
- **Steam tools still appear as games** — only the redistributables package is filtered; apps like Wallpaper Engine can be hidden from the three-dot menu.
- **Gamepad needs a first press** — WebView2 exposes controllers only after a button is pressed; controller mode is opened from the sidebar.

---

## File Structure
```
game-launcher/
├── src-tauri/
│   ├── src/
│   │   ├── main.rs              # Entry point
│   │   ├── lib.rs               # Tauri builder + state management
│   │   ├── tray.rs              # Tray icon + "keep running in the tray"
│   │   ├── models/
│   │   │   ├── mod.rs           # GameEntry, GameSource, CoverSuggestion, DetectedStore
│   │   │   └── store_config.rs  # StoreConfig (store_config.json)
│   │   ├── scanners/
│   │   │   ├── mod.rs           # PlatformScanner trait
│   │   │   ├── steam.rs         # Steam scanner (dedup + 600x900 covers)
│   │   │   ├── epic.rs          # Epic Games scanner
│   │   │   └── gog.rs           # GOG scanner
│   │   ├── services/
│   │   │   ├── mod.rs
│   │   │   ├── aggregator.rs    # Combines scanners; enabled-store filtering
│   │   │   ├── cache.rs         # Disk cache + favorites persistence (app data dir)
│   │   │   └── launcher.rs      # Game launching + shell_open (links without cmd)
│   │   └── commands/mod.rs      # Tauri commands
│   ├── icons/                   # App icon set + per-store PNGs (generated)
│   └── tauri.conf.json
├── scripts/
│   └── generate-icons.mjs       # Icon generator (sharp)
├── src/
│   ├── main.js                  # Frontend logic
│   ├── styles/main.css          # Dark theme + UI styles
│   └── assets/design/           # Design reference
├── index.html                   # Entry HTML
├── CHANGELOG.md                 # This file
└── README.md
```
