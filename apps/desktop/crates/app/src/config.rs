//! Runtime configuration from the environment, plus a saved non-secret theme preference.

use std::path::PathBuf;

use chrono::NaiveDate;
use sob_core::i18n::Locale;
use url::{Host, Url};

const DEFAULT_API_ORIGIN: &str = "http://127.0.0.1:3000";

#[derive(Debug, Clone)]
pub struct Config {
    /// API origin, e.g. `http://127.0.0.1:3000`. `SOB_API_URL`.
    pub api_url: String,
    pub api_url_locked: bool,
    /// Where the replica and the session live. `SOB_DATA_DIR`, else the XDG data dir.
    pub data_dir: PathBuf,
    /// `SOB_LANG`, else `LANG`; English unless Spanish.
    pub locale: Locale,
    /// `SOB_START_DATE` (`YYYY-MM-DD`): open the calendar on that day instead of today.
    pub start_date: Option<NaiveDate>,
    /// `SOB_START_VIEW` (`new`, `details` or `conflicts`): open that dialog at startup. A QA
    /// convenience for looking at dialogs without clicking through (screenshots, demos).
    pub start_view: Option<String>,
}

impl Config {
    pub fn from_env() -> Self {
        let get = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
        let data_dir = get("SOB_DATA_DIR").map(PathBuf::from).unwrap_or_else(|| {
            let base = get("XDG_DATA_HOME").map(PathBuf::from).or_else(|| {
                get("HOME").map(|h| {
                    if cfg!(target_os = "macos") {
                        PathBuf::from(h).join("Library").join("Application Support")
                    } else {
                        PathBuf::from(h).join(".local").join("share")
                    }
                })
            });
            base.unwrap_or_else(|| PathBuf::from("."))
                .join("sisters-of-beauty")
                .join("desktop")
        });
        let explicit = get("SOB_API_URL");
        let configured = explicit
            .clone()
            .or_else(|| std::fs::read_to_string(data_dir.join("api-url")).ok());
        let api_url = match configured
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            None => DEFAULT_API_ORIGIN.into(),
            // Keep the exact valid legacy key so the saved replica and queue can still be found.
            Some(value) if server_origin(value).is_some() && value.contains("://") => {
                value.trim_end_matches('/').to_owned()
            }
            Some(_) => String::new(),
        };
        Self {
            api_url_locked: explicit.is_some() && !api_url.is_empty(),
            api_url,
            data_dir,
            locale: Locale::detect(&get("SOB_LANG").or_else(|| get("LANG")).unwrap_or_default()),
            start_date: get("SOB_START_DATE").and_then(|d| d.parse().ok()),
            start_view: get("SOB_START_VIEW"),
        }
    }

    /// Use the canonical network origin without changing the historical key for local data.
    pub fn network_origin(&self) -> String {
        server_origin(&self.api_url).unwrap_or_default()
    }

    pub fn db_path(&self, session: &sob_core::auth::Session) -> PathBuf {
        sob_core::auth::replica_path(&self.data_dir, &self.api_url, session)
    }

    pub fn session_path(&self) -> PathBuf {
        sob_core::auth::server_data_dir(&self.data_dir, &self.api_url).join("session.json")
    }

    pub fn needs_server_setup(&self) -> bool {
        self.api_url.is_empty()
            || (self.api_url == DEFAULT_API_ORIGIN
                && !self.api_url_locked
                && !self.data_dir.join("api-url").is_file())
    }

    pub fn save_server(&self) -> std::io::Result<()> {
        save_address(&self.data_dir.join("api-url"), &self.api_url)
    }

    pub fn remember_server_key(&self) -> std::io::Result<()> {
        if let Some(origin) = server_origin(&self.api_url)
            && origin != self.api_url
            && sob_core::auth::server_data_dir(&self.data_dir, &self.api_url).is_dir()
        {
            let marker =
                sob_core::auth::server_data_dir(&self.data_dir, &origin).join("legacy-origin");
            return save_address(&marker, &self.api_url);
        }
        Ok(())
    }

    pub fn retained_server_key(&self, origin: String) -> String {
        let marker = sob_core::auth::server_data_dir(&self.data_dir, &origin).join("legacy-origin");
        std::fs::read_to_string(marker)
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| value.contains("://") && server_origin(value).as_ref() == Some(&origin))
            .unwrap_or(origin)
    }

    pub fn saved_theme(&self) -> Option<bool> {
        match std::fs::read_to_string(self.data_dir.join("theme"))
            .ok()?
            .trim()
        {
            "dark" => Some(true),
            "light" => Some(false),
            _ => None,
        }
    }

    pub fn save_theme(&self, dark: bool) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.data_dir)?;
        let temporary = self
            .data_dir
            .join(format!(".theme-{}.tmp", std::process::id()));
        std::fs::write(&temporary, if dark { "dark\n" } else { "light\n" })?;
        std::fs::rename(temporary, self.data_dir.join("theme"))
    }
}

fn save_address(path: &std::path::Path, origin: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    std::fs::write(&temporary, format!("{origin}\n"))?;
    std::fs::rename(temporary, path)
}

/// Select the web origin explicitly. Plain HTTP is only allowed for a local development server.
pub fn server_origin(value: &str) -> Option<String> {
    let value = value.trim();
    let (scheme, authority) = value.split_once("://").unwrap_or(("https", value));
    let authority = authority.strip_suffix('/').unwrap_or(authority);
    if authority.is_empty()
        || authority
            .chars()
            .any(|ch| ch.is_whitespace() || ch.is_control() || "/\\@?#%".contains(ch))
    {
        return None;
    }
    let parsed = Url::parse(&format!("{scheme}://{authority}")).ok()?;
    let loopback = match parsed.host()? {
        Host::Domain(domain) => domain == "localhost",
        Host::Ipv4(address) => address.is_loopback(),
        Host::Ipv6(address) => address.is_loopback(),
    };
    if parsed.scheme() != "https" && !(loopback && parsed.scheme() == "http") {
        return None;
    }
    Some(parsed.origin().ascii_serialization())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_previous_noncanonical_address_keeps_its_existing_storage_key() {
        let data = tempfile::tempdir().unwrap();
        let config = Config {
            api_url: "https://CITAME.example:443".into(),
            api_url_locked: false,
            data_dir: data.path().to_path_buf(),
            locale: Locale::En,
            start_date: None,
            start_view: None,
        };
        let normalized = "https://citame.example";
        std::fs::create_dir_all(config.session_path().parent().unwrap()).unwrap();
        config.remember_server_key().unwrap();
        assert_eq!(
            config.retained_server_key(normalized.into()),
            config.api_url
        );
        assert_eq!(
            config.retained_server_key("https://another.example".into()),
            "https://another.example"
        );
    }

    #[test]
    fn server_addresses_are_origins_and_require_tls_except_on_loopback() {
        for (address, expected) in [
            (" citame.example ", "https://citame.example"),
            ("https://Citame.Example:443/", "https://citame.example"),
            ("http://localhost:4278", "http://localhost:4278"),
            ("http://127.0.0.1:4278/", "http://127.0.0.1:4278"),
            ("http://[::1]:4278", "http://[::1]:4278"),
        ] {
            assert_eq!(
                server_origin(address).as_deref(),
                Some(expected),
                "{address}"
            );
        }
        for address in [
            "",
            "http://citame.example",
            "http://192.168.1.12",
            "http://localhost.example",
            "https://user:password@citame.example",
            "https://citame.example/admin",
            "https://citame.example?target=test",
            "https://citame.example#anchor",
            "https://citame.example\\admin",
            "file:///somewhere",
        ] {
            assert_eq!(server_origin(address), None, "{address}");
        }
    }
}
