//! Runtime configuration from the environment, plus a saved non-secret theme preference.

use std::path::PathBuf;

use chrono::NaiveDate;
use sob_core::i18n::Locale;

#[derive(Debug, Clone)]
pub struct Config {
    /// API origin, e.g. `http://127.0.0.1:3000`. `SOB_API_URL`.
    pub api_url: String,
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
            let base = get("XDG_DATA_HOME")
                .map(PathBuf::from)
                .or_else(|| get("HOME").map(|h| PathBuf::from(h).join(".local").join("share")));
            base.unwrap_or_else(|| PathBuf::from("."))
                .join("sisters-of-beauty")
                .join("desktop")
        });
        Self {
            api_url: get("SOB_API_URL").unwrap_or_else(|| "http://127.0.0.1:3000".into()),
            data_dir,
            locale: Locale::detect(&get("SOB_LANG").or_else(|| get("LANG")).unwrap_or_default()),
            start_date: get("SOB_START_DATE").and_then(|d| d.parse().ok()),
            start_view: get("SOB_START_VIEW"),
        }
    }

    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join("replica.db")
    }

    pub fn session_path(&self) -> PathBuf {
        self.data_dir.join("session.json")
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
