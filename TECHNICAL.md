# Game Console Alpha: technical details

This is the developer-facing companion to the [README](README.md). It covers how the app works, where it keeps data, how the code is laid out, and how to build and package it. The full change history is in [CHANGELOG.md](CHANGELOG.md).

**Contents**
- [Tech stack](#tech-stack)
- [How it works](#how-it-works)
  - [Finding installed games](#finding-installed-games)
  - [Owned but not installed games](#owned-but-not-installed-games)
  - [Trending page](#trending-page)
  - [Cover art](#cover-art)
- [Where data is stored](#where-data-is-stored)
- [Project structure](#project-structure)
- [Building and running](#building-and-running)
- [Microsoft Store package (MSIX)](#microsoft-store-package-msix)
- [Tests](#tests)
- [Contributing](#contributing)

---

## Tech stack

| Layer     | Technology                                                                 |
| --------- | -------------------------------------------------------------------------- |
| Shell     | [Tauri 2](https://tauri.app/) (WebView2 on Windows)                        |
| Backend   | Rust: scanners, launch, store libraries, Steam data, tray                  |
| Frontend  | Plain JavaScript (one `main.js`), built with Vite, no framework            |
| Styling   | Hand-written CSS, bundled Schibsted Grotesk font                           |
| Packaging | NSIS installer (GitHub Releases) and MSIX (Microsoft Store)                |
| Platform  | Windows 10 (2004+) and Windows 11, 64-bit                                  |

The frontend talks to the backend through Tauri commands (`src-tauri/src/commands/`). The app sends no telemetry. Every network request is listed in the [privacy policy](https://giksaw.github.io/ConsoleAlpha/privacy-policy.html).

---

## How it works

### Finding installed games

Each launcher has a scanner in `src-tauri/src/scanners/`. They read local files and registry entries only; nothing is fetched from the internet.

| Store           | Source                                                              | Launched via                       |
| --------------- | ------------------------------------------------------------------- | ---------------------------------- |
| Steam           | Registry `SteamPath` → `libraryfolders.vdf` → `appmanifest_*.acf`   | `steam://rungameid/<id>`           |
| Epic Games      | `%ProgramData%\Epic\EpicGamesLauncher\Data\Manifests\*.item`        | `com.epicgames.launcher://` link   |
| GOG Galaxy      | Registry `HKLM\SOFTWARE\WOW6432Node\GOG.com\Games`                  | The game's executable              |
| Battle.net      | Uninstall entries run by `Blizzard Uninstaller.exe --uid=…`         | The game's `… Launcher.exe`        |
| Ubisoft Connect | Registry `…\Ubisoft\Launcher\Installs\<id>`                         | `uplay://launch/<id>/0`            |
| EA App / Origin | Uninstall entries run by EA's `EAInstaller` + `__Installer\installerdata.xml` | The game's executable (starts the EA app) |
| Xbox            | `<drive>:\XboxGames\*\Content\MicrosoftGame.config`                 | `shell:AppsFolder\<family>!<app>`  |
| Amazon Games    | Uninstall entries run by `Amazon Game Remover.exe -p <id>`          | `amazon-games://play/<id>`         |
| itch.io         | `%APPDATA%\itch\apps\*\.itch\receipt.json.gz`                       | The game's executable              |
| Rockstar Games  | Uninstall entries run by `Rockstar Games\Launcher\uninstall.exe`    | The game's executable              |

`services/aggregator.rs` merges the results. When two stores report the same install folder (for example, an EA game bought on Steam), the game is listed once, under the store scanned first.

**Game folders** (`services/game_folders.rs`): the user picks folders such as `D:\Games`. Each subfolder that isn't in the library yet is offered as a new game, once. Answers are remembered in `game_folders.json`.

### Owned but not installed games

Both of these are read from the launcher's own local files. No login and no Web API key are needed.

- **Steam** (`services/steam_library.rs`):
  - Licenses come from `appcache/packageinfo.vdf`.
  - Names and types come from `appcache/appinfo.vdf`.
  - Live install progress, speed and verifying come from `logs/content_log.txt`.
- **Epic** (`services/epic_library.rs`):
  - Ownership comes from `%LOCALAPPDATA%\EpicGamesLauncher\Saved\Data\OC_<account>.dat`.
  - Names and art come from `catcache.bin`, which also lists games the user doesn't own, so it is only used to describe owned ones.

Clicking **Install** opens the store's own install dialog through its URI scheme. The download runs in that launcher.

### Trending page

`services/trending.rs` builds every list from public Steam endpoints that need no API key:

| Data                     | Endpoint                                                                     |
| ------------------------ | ---------------------------------------------------------------------------- |
| Lists, search, filters   | `store.steampowered.com/search/results/?infinite=1` (50 rows a page, `total_count`) |
| Game details (batch)     | `api.steampowered.com/IStoreBrowseService/GetItems/v1`: names, art, regional prices, reviews, tags, categories, platforms, languages |
| Most played              | `api.steampowered.com/ISteamChartsService/GetMostPlayedGames/v1`              |
| Tag list for the filters | `store.steampowered.com/tagdata/populartags/english`                          |

**Filters that the store search can do** are passed as search parameters:
- `tags`, `untags`
- `category2` (player modes and features)
- `os`, `deck_compatibility`, `vrsupport`, `supportedlang`
- `maxprice=free`, `hidef2p`, `specials`
- `sort_by`

**Filters that the store search can't do** are checked on the GetItems data. That covers max price, review %, review count, release window and years, plus every filter on the most-played chart. When those filters thin a page out, up to six store pages are read to fill it.

Prices use the country from Windows' region setting. Pages are cached in memory for 30 minutes (5 for searches).

`services/torrent.rs` checks whether community catalogs in Hydra format list a game. They are fetched from `raw.githubusercontent.com`, with `cdn.jsdelivr.net` as a fallback, cached for 6 hours and matched locally. The app never downloads a torrent or shows a magnet link. It only links to each source's website.

### Cover art

Covers are chosen in this order:
1. Your own picks.
2. A by-name Steam lookup.
3. The store's own art.

For games that aren't on Steam, you can add a free [SteamGridDB](https://www.steamgriddb.com/profile/preferences/api) API key in **Sources & settings → Artwork**. It is stored locally and sent only to SteamGridDB.

---

## Where data is stored

| Data | Location |
| ---- | -------- |
| Library cache, favorites, store toggles, game folders | `%APPDATA%\com.giksaw.gameconsolealpha\*.json` (`game_cache.json`, `favorites.json`, `game_folders.json`, …) |
| Custom games, settings (including the SteamGridDB key), statuses, hidden games, last launches, cover lookups, install sizes, Trending filters | WebView `localStorage` (`cabinet_*` keys) |
| Custom cover images | WebView IndexedDB (`cabinet` → `covers`) |

The GitHub and Microsoft Store builds share these locations. The MSIX turns off file and registry virtualization, so games started from it also write to the real AppData and registry.

---

## Project structure

```
├── index.html                  # App shell
├── src/
│   ├── main.js                 # The whole frontend: library, Trending, settings, controller mode
│   └── styles/main.css
├── src-tauri/
│   ├── tauri.conf.json         # Window, CSP, bundle (NSIS) settings
│   ├── Cargo.toml
│   └── src/
│       ├── main.rs / lib.rs    # App setup, command registration
│       ├── tray.rs             # "Keep running in the tray"
│       ├── commands/           # Tauri commands the frontend calls (+ game folders)
│       ├── models/             # GameEntry, StoreConfig, …
│       ├── scanners/           # One file per launcher (+ common.rs helpers)
│       └── services/
│           ├── aggregator.rs   # Runs the scanners, merges and de-duplicates
│           ├── launcher.rs     # Starts games (URI schemes or executables)
│           ├── cache.rs        # Library cache + favorites on disk
│           ├── store_library.rs, steam_library.rs, epic_library.rs  # Owned games + installs
│           ├── game_folders.rs # Watched game folders
│           ├── trending.rs     # Trending tabs, search and filters
│           ├── torrent.rs      # Download-catalog lookup for the details panel
│           └── http.rs         # Shared HTTP client
├── docs/                       # GitHub Pages: privacy policy, README screenshots
├── msix/                       # Store manifest template, identity, listing text
├── scripts/                    # MSIX packaging, icon generation
└── CHANGELOG.md                # Detailed development log
```

---

## Building and running

**You need:** [Node.js](https://nodejs.org/) 18+, [Rust](https://www.rust-lang.org/tools/install) (stable), and the [Tauri 2 prerequisites](https://tauri.app/start/prerequisites/) (MSVC build tools, WebView2).

```bash
git clone https://github.com/giksaw/ConsoleAlpha.git
cd ConsoleAlpha
npm install
npm run tauri dev      # app with hot reload
npm run tauri build    # release installer
```

The installer is written to `src-tauri/target/release/bundle/nsis/Game Console Alpha_<version>_x64-setup.exe`. It is published on GitHub Releases as `GameConsoleAlpha-<version>-x64-setup.exe`.

The version is set in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`. Keep all three in step.

To run the frontend alone in a browser, use `npm run dev` and open http://localhost:1420. Scanning, launching and Trending need the Tauri backend, so they don't work this way.

---

## Microsoft Store package (MSIX)

```bash
npm run package:msix                 # build the app, then package it
npm run package:msix -- --no-build   # package the exe that's already built
```

- **Tooling:** needs the free [Windows SDK](https://developer.microsoft.com/windows/downloads/windows-sdk/) for `makeappx.exe`.
- **Output:** `src-tauri/target/msix/`. It's left unsigned, because the Store signs it on submission.
- **Identity:** copy the values from Partner Center → *Product identity* into `msix/identity.json`.
- **Test locally:** turn on Developer Mode, then run:
  - `Add-AppxPackage -Register src-tauri\target\msix\stage\AppxManifest.xml` to install.
  - `Get-AppxPackage *GameCabinet* | Remove-AppxPackage` to remove.
- **Restricted capabilities**, which you justify at submission:
  - `runFullTrust`: the app launches other programs.
  - `unvirtualizedResources`: games started from it must save to the real AppData and registry.

---

## Tests

```bash
cd src-tauri
cargo test --lib                                   # unit tests (scanners, parsers, filters)
cargo test --lib live_steam -- --ignored --nocapture   # hits the real Steam store
```

---

## Contributing

Ideas and bug reports go in [Issues](https://github.com/giksaw/ConsoleAlpha/issues). There is a [feature request form](https://github.com/giksaw/ConsoleAlpha/issues/new?template=feature_request.yml). Pull requests are welcome: keep changes focused and run `cargo test --lib` before opening one.

Licensed under [MIT](LICENSE).
