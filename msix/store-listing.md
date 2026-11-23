# Microsoft Store listing — Game Console Alpha

Text to paste into Partner Center. Everything here matches what the app
actually does (v0.1.0); update it when features change.

---

## Store listings → English

### Product name
Game Console Alpha

### Description
Game Console Alpha gathers the PC games you already have installed into one clean library, so you don't have to open five launchers to find something to play.

It finds games from Steam, Epic Games, GOG Galaxy, Battle.net, Ubisoft Connect, EA app, Xbox, Amazon Games, itch.io and Rockstar Games Launcher. You can also add any other game yourself by pointing it at the game's .exe file. Press Play and the game starts through its own launcher, exactly as if you had started it there.

Browse your collection in a cover-art grid or a detailed list, search by name, and sort by what you played most recently. Mark favorites, hide games you never play, and track each game as Backlog, Playing or Finished.

Prefer the couch? Controller mode gives you a full-screen, gamepad-friendly view: open it with your controller's Start button, then browse and launch with the A, B and Y buttons, or use the keyboard.

Cover art is found automatically. You can search for different artwork, use your own image, or connect a free SteamGridDB account for games that aren't on Steam.

Private by design: no account, no ads, no analytics and no tracking. Your library and settings stay on your PC. The app only goes online to fetch cover art.

Game Console Alpha is free and open source (MIT license). It is an independent app and is not affiliated with or endorsed by Valve, Epic Games, GOG, Blizzard, Ubisoft, Electronic Arts, Microsoft, Amazon, itch.io or Rockstar Games. Their names are used only to identify the launchers the app works with. Launching a game requires its own launcher to be installed.

### Product features (one per line, max 20, 200 chars each)
- One library for games from Steam, Epic Games, GOG Galaxy, Battle.net, Ubisoft Connect, EA app, Xbox, Amazon Games, itch.io and Rockstar
- Add any other game yourself by choosing its .exe, with optional launch options
- Cover-art grid and detailed list views
- Search by name and sort by recently played or A–Z
- Favorites, hidden games, and Backlog / Playing / Finished status
- Controller mode: open with the Start button, browse and play with a gamepad or keyboard
- Automatic cover art, plus your own images or SteamGridDB artwork
- Turn individual stores on or off and rescan any time
- Optionally keep running in the system tray
- No account, no ads, no tracking; your data stays on your PC

### Short description (shown in some Store views)
All your installed PC games from Steam, Epic, GOG, Xbox and more in one library, with controller mode and automatic cover art.

### Search terms (max 7)
game launcher
game library
pc games
game organizer
controller
gamepad
launcher

(Store names like Steam or Epic are left out on purpose: they're other companies' trademarks, and the description already mentions them, so search still finds the app.)

### Screenshots
At least 1, 1366×768 or larger (1920×1080 recommended), PNG. Suggested set:
1. Library grid with covers
2. List view
3. Controller mode
4. A game's details panel (status / favorite)
5. Sources & settings

Add a short caption for each, for example "Every launcher in one library".

### Copyright and trademark info
Copyright © 2026 Gladson Mathew

### Additional license terms
Open source under the MIT License: https://github.com/giksaw/ConsoleAlpha/blob/master/LICENSE

### Developed by
Giksaw Interactive

### Website
https://github.com/giksaw/ConsoleAlpha

### Support contact info
https://github.com/giksaw/ConsoleAlpha/issues

### Privacy policy URL
https://giksaw.github.io/ConsoleAlpha/privacy-policy.html

---

## Properties

- **Category:** Utilities & tools (subcategory: none). Don't choose "Games": the app is not a game.
- **Privacy:** "Yes, this product accesses, collects or transmits personal information": it sends game names to Steam search and SteamGridDB, which reveals the user's IP address. That's why a privacy policy URL is required.
- **Product declarations:** leave all unchecked, except tick "This product has been tested to meet accessibility guidelines" only if you've actually checked it.
- **System requirements:** Minimum: Windows 10 version 2004 (build 19041) or later, x64. Keyboard and mouse; gamepad optional.

---

## Age ratings (IARC questionnaire)

- **Category:** "All Other App Types" (not "Game", not "Social Networking").
- Violence, fear, sexuality, language, drugs, gambling: **No** to all.
- Users can interact or exchange content with other users: **No**.
- Shares the user's current physical location with other users: **No**.
- Digital goods purchases: **No**.
- Unrestricted internet access, such as a web browser or search engine: **No**. "Search the web" opens the user's own browser; the app itself doesn't browse.
- Displays user-generated content: **No**.

Expected result: 3+ / Everyone.

---

## Pricing and availability

- **Price:** Free
- **Markets:** All markets
- **Visibility:** Public audience, discoverable in the Store

---

## Packages

Upload `src-tauri/target/msix/GiksawInteractive.GameCabinet_0.1.0.0_x64.msix`
(build it with `npm run package:msix`). Device family: Windows Desktop.

---

## Submission options → Restricted capabilities justification

Each Partner Center box takes at most 500 characters.

**runFullTrust** (478 characters)
Game Console Alpha is a Win32 desktop app (Rust + WebView2) packaged as MSIX, so it needs runFullTrust to run. It is a launcher for PC games the user already owns: it starts game executables directly and starts store games via their launcher protocols (steam://, com.epicgames.launcher://, uplay://, shell:AppsFolder for Xbox games). It reads launchers' local install records to find installed games. It doesn't download, install or modify games and never runs as administrator.

**unvirtualizedResources** (495 characters)
The app starts the user's games and launchers as child processes. With write virtualization on, their writes to %APPDATA%, %LOCALAPPDATA% and HKCU (saves, settings, launcher logins) would be redirected into our package folder, so games would lose existing saves and settings, and new progress would be deleted when our app is uninstalled. Disabling virtualization makes games behave as if the user started them directly. The app itself writes only to its own com.giksaw.gameconsolealpha folders.

---

## Submission options → Notes for certification

Game Console Alpha is a launcher for PC games the user already has installed. It doesn't sell, download or install games.

How to test:
1. Start the app. It scans for installed launchers (Steam, Epic Games, GOG Galaxy, Battle.net, Ubisoft Connect, EA app, Xbox, Amazon Games, itch.io, Rockstar). On a machine with none of these the library will be empty, which is expected.
2. To test without any launcher: click "Add game", choose any .exe (for example C:\Windows\System32\notepad.exe), save, then click Play. The program starts.
3. "Sources & settings" shows which stores were found and lets you turn each one on or off.
4. Controller mode is in the sidebar. It can be used with a keyboard: arrow keys to move, Enter to play, Escape to go back.

No account or login is needed. The Windows App Certification Kit flags "Blocked executables" because the app starts other programs (CreateProcess / ShellExecute). That's the app's core purpose. It never runs cmd.exe, reg.exe or other system tools; those strings come from the Rust standard library.
