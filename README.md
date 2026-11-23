# Game Cabinet

A unified desktop game launcher for Windows built with [Tauri](https://tauri.app/). Scan your game libraries from Steam, Epic Games, and GOG Galaxy, add custom executables, and launch everything from one clean interface.

## Features

- **Multi-store library** — Scans Steam, Epic Games, GOG Galaxy, Battle.net, Ubisoft Connect, EA App, Xbox, Amazon Games, itch.io and Rockstar Games
- **Custom games** — Manually add executables for games not in a store library
- **Grid & list views** — Switch between a visual grid and a detailed table view
- **Search & sort** — Filter by name, sort by recently played or A-Z
- **Recently played** — Uses Steam's own last-played time, plus every launch made from Game Cabinet
- **Favorites & hiding** — Mark favorites; hide games you don't want to see (always reversible)
- **Custom cover art** — Automatic Steam artwork lookup by name, or pick your own image
- **Game status** — Organize your library with Backlog / Playing / Finished states
- **Controller mode** — Open with a gamepad's Start button; navigate and launch with a gamepad or keyboard (A = play, B = back, Y = favorite)
- **Settings** — Scan on startup, keep running in the tray, hide removed games, and per-store toggles

## Tech Stack

| Layer     | Technology                    |
| --------- | ----------------------------- |
| Frontend  | Vanilla JavaScript + Vite     |
| Backend   | Rust (Tauri 2)                |
| Styling   | Custom CSS                    |
| Platform  | Windows (Tauri desktop app)   |

## Project Structure

```
├── index.html              # App entry point
├── package.json            # Node dependencies & scripts
├── vite.config.js          # Vite configuration
├── src/
│   ├── main.js             # Frontend application logic
│   ├── styles/             # CSS stylesheets
│   └── assets/             # Frontend assets
└── src-tauri/
    ├── Cargo.toml          # Rust dependencies
    ├── tauri.conf.json     # Tauri configuration
    ├── build.rs            # Build script
    ├── src/                # Rust backend code
    │   └── main.rs
    └── icons/              # App icons
```

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Rust](https://www.rust-lang.org/tools/install) (latest stable)
- [Tauri CLI v2](https://tauri.app/start/prerequisites/)

### Installation

```bash
git clone https://github.com/giksaw/ConsoleAlpha.git
cd ConsoleAlpha
npm install
```

### Development

```bash
npm run tauri dev
```

This starts the Vite dev server and launches the Tauri desktop app with hot-reload.

### Building

```bash
npm run tauri build
```

This creates a production build in `src-tauri/target/release/bundle/`.

### Microsoft Store package (MSIX)

```bash
npm run package:msix              # build the app, then package it
npm run package:msix -- --no-build  # package the exe that's already built
```

Needs the free [Windows SDK](https://developer.microsoft.com/windows/downloads/windows-sdk/) (for `makeappx.exe`). The package lands in `src-tauri/target/msix/` and is left unsigned: the Store signs it on submission.

- **Identity**: before uploading, copy the values from Partner Center → *Product identity* into `msix/identity.json`.
- **Test locally** (Settings → System → For developers → Developer Mode on):
  `Add-AppxPackage -Register src-tauri\target\msix\stage\AppxManifest.xml`. Remove it with
  `Get-AppxPackage *GameCabinet* | Remove-AppxPackage`.
- The manifest asks for two restricted capabilities you justify at submission: `runFullTrust` (it launches other programs) and `unvirtualizedResources` (games started from it must save to the real AppData/registry, not inside the launcher's package).

### Frontend-only (Browser Mode)

You can also run the frontend without the Tauri backend:

```bash
npm run dev
```

Open http://localhost:1420 in your browser. Note that game scanning and launching require the Tauri backend.

## Store Detection

Game Cabinet reads installed games from:

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

When two stores report the same install folder (e.g. an EA game bought on
Steam), it is listed once, under the store scanned first.

## Cover art

Covers come from your own picks first, then a by-name Steam lookup, then the
store's own art. For games that aren't on Steam, add a free
[SteamGridDB](https://www.steamgriddb.com/profile/preferences/api) API key in
**Sources & settings → Artwork**; it is stored locally and only sent to SteamGridDB.

## Where data is stored

| Data                                   | Location                                  |
| -------------------------------------- | ----------------------------------------- |
| Library cache, favorites, store toggles | `%APPDATA%\com.gamelauncher.app\*.json`   |
| Custom games, settings (incl. SteamGridDB key), statuses, hidden games, last launches, cover lookups, install sizes | WebView `localStorage` (`cabinet_*` keys) |
| Custom cover images                    | WebView IndexedDB (`cabinet` → `covers`)  |

## License

MIT — see [LICENSE](LICENSE). Privacy policy: [docs/privacy-policy.html](docs/privacy-policy.html), published with GitHub Pages at https://giksaw.github.io/ConsoleAlpha/privacy-policy.html once the repo is public.
