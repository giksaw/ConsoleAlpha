//! Amazon Games: each title has an uninstall entry whose UninstallString runs
//! `Amazon Game Remover.exe … -p <product id>`. Launched with
//! `amazon-games://play/<product id>`.

use super::common::{flag_value, folder_name, guess_executable, id_part, make_entry, uninstall_entries};
use crate::models::{GameEntry, GameSource};
use crate::scanners::PlatformScanner;
use std::path::PathBuf;

pub struct AmazonScanner;

impl PlatformScanner for AmazonScanner {
    fn scan(&self) -> Vec<GameEntry> {
        uninstall_entries()
            .into_iter()
            .filter_map(|e| {
                let product = amazon_product_id(&e.uninstall_string)?;
                if e.install_location.is_empty() {
                    return None;
                }
                let dir = PathBuf::from(&e.install_location);
                let name = if e.display_name.is_empty() { folder_name(&dir) } else { e.display_name };
                let exe = guess_executable(&dir, &name);
                Some(make_entry(
                    GameSource::Amazon,
                    format!("amazon_{}", id_part(&product)),
                    name,
                    &dir,
                    exe,
                    Some(format!("amazon-games://play/{}", product)),
                    None,
                ))
            })
            .collect()
    }
}

fn amazon_product_id(uninstall_string: &str) -> Option<String> {
    if !uninstall_string.to_lowercase().contains("amazon game remover") {
        return None;
    }
    flag_value(uninstall_string, "-p")
}

#[cfg(test)]
mod tests {
    use super::amazon_product_id;

    #[test]
    fn parses_product_id() {
        let s = r#""C:\Users\me\AppData\Local\Amazon Games\App\Amazon Game Remover.exe" -m Game -p amzn1.adg.product.5f2a"#;
        assert_eq!(amazon_product_id(s).as_deref(), Some("amzn1.adg.product.5f2a"));
        assert_eq!(amazon_product_id(r#""C:\x\unins000.exe" -p foo"#), None);
    }
}
