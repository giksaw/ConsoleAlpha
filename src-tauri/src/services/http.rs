//! Shared helpers for talking to web APIs (Steam store, SteamGridDB).

/// An HTTP client with a timeout and the app's user agent.
pub fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        // Give up on a dead route in a few seconds instead of letting a
        // blackholed IP eat the whole request timeout.
        .connect_timeout(std::time::Duration::from_secs(5))
        .user_agent(concat!("GameConsoleAlpha/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))
}

/// Percent-encode a string for use inside a URL query parameter.
pub fn encode_query(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            b' ' => out.push_str("%20"),
            other => out.push_str(&format!("%{:02X}", other)),
        }
    }
    out
}
