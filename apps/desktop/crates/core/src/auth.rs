//! Authentication behind a trait, so Phase 6 can swap the mechanism (ADR 0008).
//!
//! Today the API only has Better Auth email + password with cookie sessions (ADR 0003): the
//! desktop signs in at `POST /api/auth/sign-in/email`, keeps the signed `session_token` cookie
//! and sends it as a `Cookie` header on every sync request. The OAuth 2.1 Authorization Code +
//! PKCE flow with a loopback redirect (`pkce`) replaces `BetterAuthSession` in Phase 6, when the
//! API gets its OAuth provider.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Session {
    /// `name=value` exactly as the server set it (the value is signed; never modify it).
    pub cookie: String,
    pub user_id: String,
    pub name: String,
    pub email: String,
    pub role: String,
}

#[derive(Debug, Clone)]
pub struct Credentials {
    pub email: String,
    pub password: String,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum AuthError {
    #[error("wrong email or password")]
    InvalidCredentials,
    #[error("this account cannot use the front-desk app (role: {0})")]
    WrongRole(String),
    #[error("cannot reach the server: {0}")]
    Network(String),
    #[error("unexpected response from the server: {0}")]
    Unexpected(String),
    #[error("could not store the session: {0}")]
    Storage(String),
}

pub trait AuthProvider: Send + Sync {
    fn id(&self) -> &'static str;
    fn sign_in(&self, credentials: &Credentials) -> Result<Session, AuthError>;
    /// Headers to attach to API requests.
    fn authorize(&self, session: &Session) -> Vec<(String, String)>;
    /// `Ok(false)` when the server no longer accepts the session.
    fn validate(&self, session: &Session) -> Result<bool, AuthError>;
    fn sign_out(&self, session: &Session);
}

/// Shared between the sync transport, the stream listener and the UI; replaced on login/logout.
pub type SessionHandle = Arc<RwLock<Option<Session>>>;

pub trait TokenStore: Send + Sync {
    fn load(&self) -> Result<Option<Session>, AuthError>;
    fn save(&self, session: &Session) -> Result<(), AuthError>;
    fn clear(&self) -> Result<(), AuthError>;
}

#[derive(Default)]
pub struct MemoryTokenStore(Mutex<Option<Session>>);

impl TokenStore for MemoryTokenStore {
    fn load(&self) -> Result<Option<Session>, AuthError> {
        Ok(self.0.lock().expect("token lock").clone())
    }
    fn save(&self, session: &Session) -> Result<(), AuthError> {
        *self.0.lock().expect("token lock") = Some(session.clone());
        Ok(())
    }
    fn clear(&self) -> Result<(), AuthError> {
        *self.0.lock().expect("token lock") = None;
        Ok(())
    }
}

/// Session file readable only by the current user (mode 0600 on Unix).
pub struct FileTokenStore {
    path: PathBuf,
}

impl FileTokenStore {
    pub fn new(path: impl AsRef<Path>) -> Self {
        Self {
            path: path.as_ref().to_path_buf(),
        }
    }
}

impl TokenStore for FileTokenStore {
    fn load(&self) -> Result<Option<Session>, AuthError> {
        match std::fs::read_to_string(&self.path) {
            Ok(text) => Ok(serde_json::from_str(&text).ok()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(AuthError::Storage(e.to_string())),
        }
    }

    fn save(&self, session: &Session) -> Result<(), AuthError> {
        let storage = |e: std::io::Error| AuthError::Storage(e.to_string());
        if let Some(dir) = self.path.parent().filter(|d| !d.as_os_str().is_empty()) {
            std::fs::create_dir_all(dir).map_err(storage)?;
        }
        let tmp = self.path.with_extension("tmp");
        let json = serde_json::to_vec(session).map_err(|e| AuthError::Storage(e.to_string()))?;
        {
            let mut opts = std::fs::OpenOptions::new();
            opts.write(true).create(true).truncate(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                opts.mode(0o600);
            }
            let mut f = opts.open(&tmp).map_err(storage)?;
            std::io::Write::write_all(&mut f, &json).map_err(storage)?;
        }
        std::fs::rename(&tmp, &self.path).map_err(storage)
    }

    fn clear(&self) -> Result<(), AuthError> {
        match std::fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(AuthError::Storage(e.to_string())),
        }
    }
}

/// Picks the Better Auth session cookie (`better-auth.session_token`, or its `__Secure-` form)
/// out of the `Set-Cookie` headers and returns it as `name=value`.
pub fn session_cookie_from_set_cookie(headers: &[String]) -> Option<String> {
    headers.iter().find_map(|h| {
        let pair = h.split(';').next()?.trim();
        let (name, value) = pair.split_once('=')?;
        (name.ends_with("session_token") && !value.is_empty()).then(|| pair.to_owned())
    })
}

/// Email + password sessions against Better Auth (today's API).
pub struct BetterAuthSession {
    base_url: String,
    agent: ureq::Agent,
}

impl BetterAuthSession {
    pub fn new(base_url: &str) -> Self {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(TIMEOUT))
            .build()
            .into();
        Self {
            base_url: base_url.trim_end_matches('/').to_owned(),
            agent,
        }
    }
}

#[derive(Deserialize)]
struct SignInUser {
    id: String,
    name: String,
    email: String,
    #[serde(default)]
    role: String,
}

#[derive(Deserialize)]
struct SignInBody {
    user: SignInUser,
}

impl AuthProvider for BetterAuthSession {
    fn id(&self) -> &'static str {
        "better-auth-session"
    }
    fn sign_in(&self, credentials: &Credentials) -> Result<Session, AuthError> {
        let body =
            serde_json::json!({"email": credentials.email, "password": credentials.password});
        let mut resp = self
            .agent
            .post(&format!("{}/api/auth/sign-in/email", self.base_url))
            .content_type("application/json")
            .send(body.to_string())
            .map_err(|e| AuthError::Network(e.to_string()))?;
        let status = resp.status().as_u16();
        let cookies: Vec<String> = resp
            .headers()
            .get_all("set-cookie")
            .iter()
            .filter_map(|v| v.to_str().ok().map(str::to_owned))
            .collect();
        let text = resp
            .body_mut()
            .read_to_string()
            .map_err(|e| AuthError::Network(e.to_string()))?;
        match status {
            200 => {}
            401 | 400 | 403 => return Err(AuthError::InvalidCredentials),
            429 => {
                return Err(AuthError::Network(
                    "too many attempts, wait a minute".into(),
                ));
            }
            other => return Err(AuthError::Unexpected(format!("HTTP {other}"))),
        }
        let parsed: SignInBody =
            serde_json::from_str(&text).map_err(|e| AuthError::Unexpected(e.to_string()))?;
        if parsed.user.role == "client" {
            return Err(AuthError::WrongRole(parsed.user.role));
        }
        let cookie = session_cookie_from_set_cookie(&cookies)
            .ok_or_else(|| AuthError::Unexpected("no session cookie in the response".into()))?;
        Ok(Session {
            cookie,
            user_id: parsed.user.id,
            name: parsed.user.name,
            email: parsed.user.email,
            role: parsed.user.role,
        })
    }
    fn authorize(&self, session: &Session) -> Vec<(String, String)> {
        vec![("Cookie".to_owned(), session.cookie.clone())]
    }
    fn validate(&self, session: &Session) -> Result<bool, AuthError> {
        let resp = self
            .agent
            .get(&format!("{}/me", self.base_url))
            .header("Cookie", &session.cookie)
            .call()
            .map_err(|e| AuthError::Network(e.to_string()))?;
        match resp.status().as_u16() {
            200 => Ok(true),
            401 => Ok(false),
            other => Err(AuthError::Unexpected(format!("HTTP {other}"))),
        }
    }
    fn sign_out(&self, session: &Session) {
        let _ = session;
    }
}

const TIMEOUT: Duration = Duration::from_secs(20);

#[cfg(test)]
mod tests;
