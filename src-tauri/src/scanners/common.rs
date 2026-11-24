//! Helpers shared by the launcher scanners: the Windows "Uninstall" registry,
//! executable guessing and tiny text parsers (no XML/arg-parsing dependencies).

use crate::models::{GameEntry, GameSource};
use std::fs;
use std::path::{Path, PathBuf};
use winreg::enums::*;
use winreg::RegKey;

/// One entry from Windows' installed-programs list.
#[derive(Debug, Clone, Default)]
pub struct UninstallEntry {
    /// The registry key name (often a product id or GUID).
    pub key: String,
    pub display_name: String,
    pub install_location: String,
    pub uninstall_string: String,
    pub display_icon: String,
}

/// Every program in HKLM (64- and 32-bit views) and HKCU "Uninstall" keys.
pub fn uninstall_entries() -> Vec<UninstallEntry> {
    const PATHS: &[(winreg::HKEY, &str)] = &[
        (HKEY_LOCAL_MACHINE, "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall"),
        (HKEY_LOCAL_MACHINE, "SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall"),
        (HKEY_CURRENT_USER, "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall"),
    ];
    let mut out = Vec::new();
    for (root, path) in PATHS {
        let Ok(parent) = RegKey::predef(*root).open_subkey(path) else {
            continue;
        };
        for key in parent.enum_keys().flatten() {
            let Ok(sub) = parent.open_subkey(&key) else {
                continue;
            };
            let get = |name: &str| sub.get_value::<String, _>(name).unwrap_or_default();
            out.push(UninstallEntry {
                display_name: get("DisplayName").trim().to_string(),
                install_location: get("InstallLocation").trim().to_string(),
                uninstall_string: get("UninstallString"),
                display_icon: get("DisplayIcon"),
                key,
            });
        }
    }
    out
}

/// `"C:\Games\x.exe",0` → `C:\Games\x.exe`, only if it is an existing .exe.
pub fn icon_exe(display_icon: &str) -> Option<PathBuf> {
    let s = display_icon.trim();
    let s = match s.rfind(',') {
        // Strip an icon index like ",0" / ",-101".
        Some(i) if s[i + 1..].trim().trim_start_matches('-').chars().all(|c| c.is_ascii_digit()) => &s[..i],
        _ => s,
    };
    let path = PathBuf::from(s.trim().trim_matches('"'));
    let is_exe = path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("exe"));
    (is_exe && path.is_file()).then_some(path)
}

/// Value of a command-line flag inside an uninstall string:
/// `--uid=prometheus`, `--uid prometheus`, `-p amzn1.adg...`, `-uninstall=gta5`.
pub fn flag_value(command: &str, flag: &str) -> Option<String> {
    // ASCII lowercasing keeps byte offsets identical, so indexes map back to `command`.
    let lower = command.to_ascii_lowercase();
    let flag_l = flag.to_ascii_lowercase();
    let mut from = 0;
    while let Some(pos) = lower[from..].find(&flag_l) {
        let start = from + pos;
        let end = start + flag_l.len();
        // The flag must start a token (not be the tail of another word).
        let at_token_start =
            start == 0 || matches!(lower.as_bytes()[start - 1], b' ' | b'"' | b'\t');
        let next = lower.as_bytes().get(end).copied();
        if at_token_start && matches!(next, Some(b'=') | Some(b' ')) {
            let rest = command[end + 1..].trim_start();
            let value = if let Some(stripped) = rest.strip_prefix('"') {
                stripped.split('"').next().unwrap_or("")
            } else {
                rest.split(|c: char| c.is_whitespace() || c == '"').next().unwrap_or("")
            };
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
        from = end;
    }
    None
}

/// First `attr="…"` on the first `<tag …>` element.
pub fn xml_attr(xml: &str, tag: &str, attr: &str) -> Option<String> {
    let open = format!("<{}", tag);
    let mut search = 0;
    while let Some(pos) = xml[search..].find(&open) {
        let start = search + pos + open.len();
        // Make sure we matched the whole tag name (`<Executable`, not `<ExecutableList`).
        if xml[start..].starts_with(|c: char| c.is_whitespace() || c == '/' || c == '>') {
            let end = start + xml[start..].find('>')?;
            let element = &xml[start..end];
            let needle = format!("{}=\"", attr);
            let mut s = 0;
            while let Some(p) = element[s..].find(&needle) {
                let at = s + p;
                if at == 0 || element.as_bytes()[at - 1].is_ascii_whitespace() {
                    let v = &element[at + needle.len()..];
                    return Some(unescape_xml(v.split('"').next()?));
                }
                s = at + needle.len();
            }
            return None;
        }
        search = start;
    }
    None
}

/// Text of the first `<tag …>text</tag>` element.
pub fn xml_text(xml: &str, tag: &str) -> Option<String> {
    let open = format!("<{}", tag);
    let close = format!("</{}>", tag);
    let mut search = 0;
    while let Some(pos) = xml[search..].find(&open) {
        let start = search + pos + open.len();
        if xml[start..].starts_with(|c: char| c.is_whitespace() || c == '>') {
            let body_start = start + xml[start..].find('>')? + 1;
            let body_end = body_start + xml[body_start..].find(&close)?;
            let text = unescape_xml(xml[body_start..body_end].trim());
            return (!text.is_empty()).then_some(text);
        }
        search = start;
    }
    None
}

fn unescape_xml(s: &str) -> String {
    s.replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

/// Last path component of a folder, for when a launcher records no title.
pub fn folder_name(path: &Path) -> String {
    path.components()
        .next_back()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .unwrap_or_default()
}

/// Best guess at a game's main executable inside its install folder.
///
/// Prefers `<name>.exe`, then the best entry from [`list_executables`].
pub fn guess_executable(dir: &Path, game_name: &str) -> Option<PathBuf> {
    if !dir.is_dir() {
        return None;
    }
    let direct = dir.join(format!("{}.exe", game_name));
    if direct.is_file() {
        return Some(direct);
    }
    list_executables(dir, 1).into_iter().next()
}

/// The likely game executables within a few levels of `dir`, best first:
/// largest first, shallower first on a tie. Installers, uninstallers, crash
/// reporters and redistributables are left out. Returns at most `limit`.
pub fn list_executables(dir: &Path, limit: usize) -> Vec<PathBuf> {
    const SKIP: &[&str] = &[
        "unins", "uninstall", "setup", "install", "crash", "report", "redist", "vcredist",
        "vc_redist", "dxsetup", "dotnet", "directx", "ue4prereq", "easyanticheat", "be_service",
        "battleye", "cleanup", "touchup", "activation", "helper", "updater",
    ];
    if !dir.is_dir() {
        return Vec::new();
    }
    let mut found: Vec<(u64, usize, PathBuf)> = Vec::new();
    for entry in walkdir::WalkDir::new(dir)
        .max_depth(4)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        let is_exe = path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("exe"));
        if !is_exe || !entry.file_type().is_file() {
            continue;
        }
        let stem = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let in_skipped_dir = path.components().any(|c| {
            let c = c.as_os_str().to_string_lossy().to_lowercase();
            c == "_commonredist" || c == "redist" || c == "__installer" || c == "support"
        });
        if in_skipped_dir || SKIP.iter().any(|s| stem.contains(s)) {
            continue;
        }
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        found.push((size, entry.depth(), path.to_path_buf()));
    }
    found.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    found.into_iter().take(limit).map(|(_, _, p)| p).collect()
}

/// A readable game title from a folder name: `Hades_v1.38 [GOG]` → `Hades`,
/// `Hollow.Knight.v1.5` → `Hollow Knight`. Only a default; the user can edit it.
pub fn clean_title(folder: &str) -> String {
    // Drop bracketed tags: [GOG], (2019), {Repack}.
    let mut s = String::new();
    let mut depth = 0usize;
    for c in folder.chars() {
        match c {
            '[' | '(' | '{' => depth += 1,
            ']' | ')' | '}' => depth = depth.saturating_sub(1),
            _ if depth == 0 => s.push(c),
            _ => {}
        }
    }
    // Drop a trailing version ("v1.38", "1.0.2") or build number ("Build 1234").
    loop {
        let cut = (1..s.len()).find(|&i| {
            s.is_char_boundary(i)
                && matches!(s.as_bytes()[i - 1], b' ' | b'_' | b'.' | b'-')
                && is_version_suffix(&s[i..])
        });
        match cut {
            Some(i) => s.truncate(i - 1),
            None => break,
        }
    }
    let mut s = s.replace('_', " ");
    // Scene-style names use dots for spaces; initialisms like S.T.A.L.K.E.R don't.
    if !s.contains(' ') && s.split('.').any(|part| part.chars().count() > 1) && s.contains('.') {
        s = s.replace('.', " ");
    }
    let title = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let title = title.trim_matches(|c: char| c == '-' || c.is_whitespace()).to_string();
    if title.is_empty() {
        folder.trim().to_string()
    } else {
        title
    }
}

/// `v1.38`, `1.0.2`, `v2` or `build 1234` (case-insensitive), and nothing else.
fn is_version_suffix(rest: &str) -> bool {
    let rest = rest.trim().to_ascii_lowercase();
    if let Some(num) = rest.strip_prefix("build") {
        let num = num.trim_start_matches([' ', '_', '.', '-']);
        return !num.is_empty() && num.chars().all(|c| c.is_ascii_digit());
    }
    let (had_v, body) = match rest.strip_prefix('v') {
        Some(b) => (true, b),
        None => (false, rest.as_str()),
    };
    !body.is_empty()
        && body.chars().all(|c| c.is_ascii_digit() || c == '.')
        && body.starts_with(|c: char| c.is_ascii_digit())
        && body.ends_with(|c: char| c.is_ascii_digit())
        && (had_v || body.contains('.'))
}

/// Build a `GameEntry` for a launcher-installed game.
///
/// `launch` is a protocol link or shell target when the launcher has one;
/// otherwise the game is started from `exe`.
pub fn make_entry(
    source: GameSource,
    id: String,
    name: String,
    install_dir: &Path,
    exe: Option<PathBuf>,
    launch: Option<String>,
    cover: Option<String>,
) -> GameEntry {
    let exe_str = exe
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    GameEntry {
        id,
        name,
        description: None,
        install_path: install_dir.to_string_lossy().to_string(),
        launch_command: launch.unwrap_or_else(|| exe_str.clone()),
        executable_path: exe_str,
        cover_image_path: cover,
        source,
        last_played: None,
        total_playtime_seconds: 0,
        is_installed: install_dir.is_dir(),
    }
}

/// Make an id segment safe and stable: lowercase, alphanumerics and `-._` only.
pub fn id_part(s: &str) -> String {
    s.trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || "-._".contains(c) { c } else { '-' })
        .collect()
}

/// Read a text file, tolerating a UTF-16 (BOM) encoding some launchers use.
pub fn read_text(path: &Path) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16(&units).ok();
    }
    let s = String::from_utf8_lossy(&bytes);
    Some(s.trim_start_matches('\u{feff}').to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flag_value_forms() {
        let bnet = r#""C:\ProgramData\Battle.net\Agent\Blizzard Uninstaller.exe" --lang=enUS --uid=prometheus --displayname="Overwatch""#;
        assert_eq!(flag_value(bnet, "--uid").as_deref(), Some("prometheus"));
        assert_eq!(flag_value(bnet, "--displayname").as_deref(), Some("Overwatch"));

        let amazon = r#""C:\Users\x\AppData\Local\Amazon Games\App\Amazon Game Remover.exe" -m Game -p amzn1.adg.product.1234-abcd"#;
        assert_eq!(flag_value(amazon, "-p").as_deref(), Some("amzn1.adg.product.1234-abcd"));
        // "-m" must not match inside "-p" etc., and absent flags are None.
        assert_eq!(flag_value(amazon, "-x"), None);

        let rockstar = r#""C:\Program Files\Rockstar Games\Launcher\uninstall.exe" -uninstall=gta5"#;
        assert_eq!(flag_value(rockstar, "-uninstall").as_deref(), Some("gta5"));
    }

    #[test]
    fn xml_helpers() {
        let xml = r#"<?xml version="1.0"?>
<Game configVersion="1">
  <Identity Name="Microsoft.624F8B84B80" Publisher="CN=Microsoft" Version="1.0.0.0"/>
  <ExecutableList>
    <Executable Name="ForzaHorizon5.exe" Id="Game" />
  </ExecutableList>
  <ShellVisuals DefaultDisplayName="Forza Horizon 5" PublisherDisplayName="Xbox Game Studios"/>
  <gameTitles><gameTitle locale="en_US">Mass Effect&amp;trade;</gameTitle></gameTitles>
</Game>"#;
        assert_eq!(xml_attr(xml, "Identity", "Name").as_deref(), Some("Microsoft.624F8B84B80"));
        assert_eq!(xml_attr(xml, "Executable", "Name").as_deref(), Some("ForzaHorizon5.exe"));
        assert_eq!(xml_attr(xml, "Executable", "Id").as_deref(), Some("Game"));
        assert_eq!(
            xml_attr(xml, "ShellVisuals", "DefaultDisplayName").as_deref(),
            Some("Forza Horizon 5")
        );
        // "Name" must not match "DefaultDisplayName" / "PublisherDisplayName".
        assert_eq!(xml_attr(xml, "ShellVisuals", "Name"), None);
        assert_eq!(xml_text(xml, "gameTitle").as_deref(), Some("Mass Effect&trade;"));
        assert_eq!(xml_text(xml, "missing"), None);
    }

    #[test]
    fn icon_exe_rejects_missing_and_non_exe() {
        assert_eq!(icon_exe(r#""C:\nope\game.exe",0"#), None);
        assert_eq!(icon_exe(r"C:\Windows\System32\shell32.dll,4"), None);
        let notepad = r"C:\Windows\System32\notepad.exe,0";
        assert_eq!(icon_exe(notepad), Some(PathBuf::from(r"C:\Windows\System32\notepad.exe")));
    }

    #[test]
    fn clean_title_strips_tags_and_versions() {
        assert_eq!(clean_title("Hades_v1.38 [GOG]"), "Hades");
        assert_eq!(clean_title("Hollow.Knight.v1.5"), "Hollow Knight");
        assert_eq!(clean_title("Celeste (2018)"), "Celeste");
        assert_eq!(clean_title("Some Game 1.0.2"), "Some Game");
        assert_eq!(clean_title("Some_Game_Build_1234"), "Some Game");
        assert_eq!(clean_title("Some Game - v2"), "Some Game");
        // Sequel numbers and initialisms are part of the title.
        assert_eq!(clean_title("Portal 2"), "Portal 2");
        assert_eq!(clean_title("Half-Life 2"), "Half-Life 2");
        assert_eq!(clean_title("S.T.A.L.K.E.R"), "S.T.A.L.K.E.R");
        assert_eq!(clean_title("Mr. Shifty"), "Mr. Shifty");
        // Never return an empty title.
        assert_eq!(clean_title("[GOG]"), "[GOG]");
    }

    #[test]
    fn list_executables_ranks_and_skips_installers() {
        let dir = std::env::temp_dir().join(format!("gca-exe-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("bin")).unwrap();
        fs::create_dir_all(dir.join("_CommonRedist")).unwrap();
        fs::write(dir.join("launcher.exe"), vec![0u8; 10]).unwrap();
        fs::write(dir.join("bin").join("game.exe"), vec![0u8; 100]).unwrap();
        fs::write(dir.join("unins000.exe"), vec![0u8; 500]).unwrap();
        fs::write(dir.join("_CommonRedist").join("big.exe"), vec![0u8; 900]).unwrap();
        fs::write(dir.join("readme.txt"), b"hi").unwrap();
        let found = list_executables(&dir, 10);
        assert_eq!(found, vec![dir.join("bin").join("game.exe"), dir.join("launcher.exe")]);
        assert_eq!(guess_executable(&dir, "nope"), Some(dir.join("bin").join("game.exe")));
        assert_eq!(guess_executable(&dir, "launcher"), Some(dir.join("launcher.exe")));
        let _ = fs::remove_dir_all(&dir);
    }
}
