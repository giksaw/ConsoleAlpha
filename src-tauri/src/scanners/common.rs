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
/// Prefers `<name>.exe`, then the largest .exe within a few levels that isn't
/// an installer, uninstaller, crash reporter or redistributable.
pub fn guess_executable(dir: &Path, game_name: &str) -> Option<PathBuf> {
    if !dir.is_dir() {
        return None;
    }
    let direct = dir.join(format!("{}.exe", game_name));
    if direct.is_file() {
        return Some(direct);
    }

    const SKIP: &[&str] = &[
        "unins", "uninstall", "setup", "install", "crash", "report", "redist", "vcredist",
        "vc_redist", "dxsetup", "dotnet", "directx", "ue4prereq", "easyanticheat", "be_service",
        "battleye", "cleanup", "touchup", "activation", "helper", "updater",
    ];
    let mut best: Option<(u64, usize, PathBuf)> = None;
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
        let depth = entry.depth();
        // Shallower wins over bigger only when sizes are comparable.
        let better = match &best {
            None => true,
            Some((bsize, bdepth, _)) => size > *bsize || (size == *bsize && depth < *bdepth),
        };
        if better {
            best = Some((size, depth, path.to_path_buf()));
        }
    }
    best.map(|(_, _, p)| p)
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
}
