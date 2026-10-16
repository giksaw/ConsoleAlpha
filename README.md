# Cabinet: Game Launcher

A unified desktop game launcher for Windows built with [Tauri](https://tauri.app/). Scan your game libraries from Steam, Epic Games, and GOG Galaxy, add custom executables, and launch everything from one clean interface.

## Features

- **Multi-store library** — Automatically detects and scans games from Steam, Epic Games, and GOG Galaxy
- **Custom games** — Manually add executables for games not in a store library
- **Grid & list views** — Switch between a visual grid and a detailed table view
- **Search & sort** — Filter by name, sort by recently played, A-Z, or most played
- **Favorites** — Mark games as favorites for quick access
- **Playtime tracking** — Tracks how long you play each game
- **Game status** — Organize your library with Backlog / Playing / Finished states
- **Controller mode** — Navigate and launch games with a gamepad (A/B/Y buttons)
- **Settings** — Configure scan-on-startup, playtime tracking, tray behavior, and more

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

### Frontend-only (Browser Mode)

You can also run the frontend without the Tauri backend:

```bash
npm run dev
```

Open http://localhost:5173 in your browser. Note that game scanning and launching require the Tauri backend.

## Store Detection

Cabinet scans the following locations for installed games:

| Store        | Default Path                                  |
| ------------ | --------------------------------------------- |
| Steam        | `C:\Program Files (x86)\Steam`                |
| Epic Games   | `C:\Program Files\Epic Games`                 |
| GOG Galaxy   | `C:\GOG Games`                                |

Additional launchers (Battle.net, Xbox, EA App, Ubisoft Connect, Heroic, Lutris) can be configured in Sources & Settings.

## License

MIT
