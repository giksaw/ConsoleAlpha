# Game Console Alpha

One library for all your PC games. Game Console Alpha finds the games you already have installed from Steam, Epic Games, GOG Galaxy, Battle.net, Ubisoft Connect, EA App, Xbox, Amazon Games, itch.io and Rockstar Games, lets you add any other game by hand, and launches everything from one clean interface — with a mouse, keyboard or controller.

## Download

**Windows 10 (version 2004 or later) and Windows 11, 64-bit.**

- **GitHub:** get `GameConsoleAlpha-<version>-x64-setup.exe` from the [latest release](https://github.com/giksaw/ConsoleAlpha/releases/latest) and run it. It installs for your user account only and doesn't need administrator rights.
- **Microsoft Store:** coming soon. The Store version updates itself automatically.

The installer isn't code-signed yet, so Windows SmartScreen may show *"Windows protected your PC"*. Click **More info → Run anyway**. The GitHub version doesn't update itself: download the new installer from Releases to update.

Install either the GitHub version or the Store version, not both. They share the same settings and library data, and both appear in Start as "Game Console Alpha".

Game Console Alpha doesn't sell or download games: when you click **Install** on a game you own, it asks Steam or Epic Games to install it, and the download runs in that launcher. It doesn't collect any data. See the [privacy policy](https://giksaw.github.io/ConsoleAlpha/privacy-policy.html).

## Features

- **Multi-store library** — Scans Steam, Epic Games, GOG Galaxy, Battle.net, Ubisoft Connect, EA App, Xbox, Amazon Games, itch.io and Rockstar Games
- **Your whole Steam and Epic library** — The Steam and Epic Games pages also list games you own but haven't installed (read from each launcher's local files: no login or API key). Click **Install** and the store's own install dialog opens; the download's progress and speed then show on the game's card
- **Trending** — Top sellers, new & trending releases, most played and upcoming games from the Steam store, plus a Steam search. Prices in your currency; games you already have are marked Installed or Owned, and you can play or install them from there
- **Custom games** — Manually add executables for games not in a store library
- **Game folders** — Pick the folders you keep games in (e.g. `C:\Games`); new game folders there are offered for your library on launch (and every 30 minutes, optionally), and only added once you confirm
- **Grid & list views** — Switch between a visual grid and a detailed table view
- **Search & sort** — Filter by name, sort by recently played or A-Z
- **Recently played** — Uses Steam's own last-played time, plus every launch made from Game Console Alpha
- **Favorites & hiding** — Mark favorites; hide games you don't want to see (always reversible)
- **Right-click menu** — Right-click any game to play, install, open its store page, open its install (or game) folder, set a cover, favorite or hide it
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

This builds the installer (NSIS) at `src-tauri/target/release/bundle/nsis/Game Console Alpha_<version>_x64-setup.exe`. This is the file published on GitHub Releases, renamed to `GameConsoleAlpha-<version>-x64-setup.exe`.

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

Game Console Alpha reads installed games from:

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
| Library cache, favorites, store toggles, game folders | `%APPDATA%\com.giksaw.gameconsolealpha\*.json` |
| Custom games, settings (incl. SteamGridDB key), statuses, hidden games, last launches, cover lookups, install sizes | WebView `localStorage` (`cabinet_*` keys) |
| Custom cover images                    | WebView IndexedDB (`cabinet` → `covers`)  |

## License

MIT — see [LICENSE](LICENSE). Privacy policy: [docs/privacy-policy.html](docs/privacy-policy.html), published at https://giksaw.github.io/ConsoleAlpha/privacy-policy.html.
