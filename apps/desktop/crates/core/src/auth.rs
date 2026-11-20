//! Desktop sign-in and private, origin-scoped session storage.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

mod browser_calendar;
mod device;
pub use browser_calendar::{BrowserHandoff, BrowserWorkspace};
use device::DeviceLink;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Session {
    /// `name=value` exactly as the server set it (the value is signed; never modify it).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub cookie: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oauth: Option<OAuthCredentials>,
    pub user_id: String,
    pub name: String,
    pub email: String,
    pub role: String,
}

impl Session {
    pub fn has_device_link(&self) -> bool {
        self.oauth
            .as_ref()
            .is_some_and(|credentials| credentials.device.is_some())
    }
}

#[derive(Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct OAuthCredentials {
    access_token: String,
    refresh_token: String,
    expires_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    device: Option<DeviceLink>,
}

impl std::fmt::Debug for OAuthCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("OAuthCredentials { [redacted] }")
    }
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: String,
    expires_in: i64,
}

/// Session and replica files are scoped to the server and the account's permissions.
pub fn server_data_dir(root: &Path, api: &str) -> PathBuf {
    let digest = Sha256::digest(api.trim().trim_end_matches('/').as_bytes());
    root.join("servers").join(URL_SAFE_NO_PAD.encode(digest))
}

pub fn replica_path(root: &Path, api: &str, session: &Session) -> PathBuf {
    let mut hash = Sha256::new();
    hash.update((session.user_id.len() as u64).to_le_bytes());
    hash.update(session.user_id.as_bytes());
    hash.update(session.role.as_bytes());
    server_data_dir(root, api)
        .join(URL_SAFE_NO_PAD.encode(hash.finalize()))
        .join("replica.db")
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
    fn authorize(&self, session: &mut Session) -> Result<Vec<(String, String)>, AuthError>;
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
            .max_redirects(0)
            .timeout_global(Some(TIMEOUT))
            .build()
            .into();
        Self {
            base_url: base_url.trim_end_matches('/').to_owned(),
            agent,
        }
    }
}

const DESKTOP_CLIENT_ID: &str = "sob-desktop";
const DESKTOP_SCOPE: &str = "desktop:sign-in";

pub struct BrowserSignIn {
    listener: crate::pkce::LoopbackReceiver,
    verifier: String,
    state: String,
    redirect: String,
    resource: String,
    pub url: String,
}

impl BetterAuthSession {
    pub fn begin_browser_sign_in(&self) -> Result<BrowserSignIn, AuthError> {
        use crate::pkce::{
            LoopbackReceiver, authorization_url, challenge_s256, new_verifier, pct_encode,
        };
        let listener =
            LoopbackReceiver::bind().map_err(|error| AuthError::Network(error.to_string()))?;
        let redirect = listener.redirect_uri();
        let verifier = new_verifier();
        let state = new_verifier();
        let resource = format!("{}/api/auth/desktop", self.base_url);
        let endpoint = format!("{}/api/auth/oauth2/authorize", self.base_url);
        let url = format!(
            "{}&scope={}&resource={}&prompt=login",
            authorization_url(
                &endpoint,
                DESKTOP_CLIENT_ID,
                &redirect,
                &state,
                &challenge_s256(&verifier)
            ),
            pct_encode(DESKTOP_SCOPE),
            pct_encode(&resource),
        );
        Ok(BrowserSignIn {
            listener,
            verifier,
            state,
            redirect,
            resource,
            url,
        })
    }

    pub fn complete_browser_sign_in(
        &self,
        flow: BrowserSignIn,
        cancelled: &AtomicBool,
    ) -> Result<Session, AuthError> {
        let callback = flow
            .listener
            .wait_cancellable(&flow.state, Duration::from_secs(180), cancelled)
            .map_err(AuthError::Unexpected)?;
        let issuer = format!("{}/api/auth", self.base_url);
        if callback.issuer.as_deref() != Some(&issuer) {
            return Err(AuthError::Unexpected("OAuth issuer mismatch".into()));
        }
        let credentials = self.request_token([
            ("grant_type", "authorization_code"),
            ("client_id", DESKTOP_CLIENT_ID),
            ("code", &callback.code),
            ("redirect_uri", &flow.redirect),
            ("code_verifier", &flow.verifier),
            ("resource", &flow.resource),
        ])?;
        if cancelled.load(Ordering::Relaxed) {
            self.revoke(&credentials);
            return Err(AuthError::Unexpected("Authorization cancelled".into()));
        }
        let mut linked = self.link_device(&credentials)?;
        let result = (|| {
            let device = linked.device.as_ref().expect("enrolled device");
            (linked.access_token, linked.expires_at) = self.renew_device(device)?;
            let user = self.viewer("Authorization", &format!("Bearer {}", linked.access_token))?;
            if cancelled.load(Ordering::Relaxed) {
                return Err(AuthError::Unexpected("Authorization cancelled".into()));
            }
            Ok(user)
        })();
        match result {
            Ok(user) => Ok(Session {
                cookie: String::new(),
                oauth: Some(linked),
                user_id: user.id,
                name: user.name,
                email: user.email,
                role: user.role,
            }),
            Err(error) => {
                if let Some(device) = &linked.device {
                    let _ = self.revoke_device(device);
                }
                Err(error)
            }
        }
    }

    fn request_token<const N: usize>(
        &self,
        form: [(&str, &str); N],
    ) -> Result<OAuthCredentials, AuthError> {
        let refresh = form.contains(&("grant_type", "refresh_token"));
        let mut response = self
            .agent
            .post(&format!("{}/api/auth/oauth2/token", self.base_url))
            .send_form(form)
            .map_err(|e| AuthError::Network(e.to_string()))?;
        match response.status().as_u16() {
            200 => {
                let token: TokenResponse = read_response(&mut response)?;
                if token.access_token.is_empty()
                    || (refresh && token.refresh_token.is_empty())
                    || token.expires_in <= 0
                {
                    return Err(AuthError::Unexpected("Invalid OAuth token response".into()));
                }
                Ok(OAuthCredentials {
                    access_token: token.access_token,
                    refresh_token: token.refresh_token,
                    device: None,
                    expires_at: chrono::Utc::now()
                        .timestamp()
                        .saturating_add(token.expires_in),
                })
            }
            400 | 401 | 403 => Err(AuthError::InvalidCredentials),
            status => Err(AuthError::Network(format!(
                "OAuth server returned HTTP {status}"
            ))),
        }
    }

    fn viewer(&self, header: &str, value: &str) -> Result<SignInUser, AuthError> {
        let mut response = self
            .agent
            .get(&format!("{}/me", self.base_url))
            .header(header, value)
            .call()
            .map_err(|e| AuthError::Network(e.to_string()))?;
        match response.status().as_u16() {
            200 => Ok(read_response::<SignInBody>(&mut response)?.user),
            401 => Err(AuthError::InvalidCredentials),
            403 => Err(AuthError::WrongRole("client".into())),
            status => Err(AuthError::Unexpected(format!("HTTP {status}"))),
        }
    }

    fn revoke(&self, credentials: &OAuthCredentials) {
        for (token, kind) in [
            (&credentials.refresh_token, "refresh_token"),
            (&credentials.access_token, "access_token"),
        ] {
            if token.is_empty() {
                continue;
            }
            let _ = self
                .agent
                .post(&format!("{}/api/auth/oauth2/revoke", self.base_url))
                .send_form([
                    ("client_id", DESKTOP_CLIENT_ID),
                    ("token", token.as_str()),
                    ("token_type_hint", kind),
                ]);
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

fn read_response<T: serde::de::DeserializeOwned>(
    response: &mut ureq::http::Response<ureq::Body>,
) -> Result<T, AuthError> {
    let body = response
        .body_mut()
        .with_config()
        .limit(64 * 1024)
        .read_to_string()
        .map_err(|error| AuthError::Network(error.to_string()))?;
    serde_json::from_str(&body)
        .map_err(|_| AuthError::Unexpected("Invalid authorization response".into()))
}

fn read_sign_in(response: &mut ureq::http::Response<ureq::Body>) -> Result<Session, AuthError> {
    let cookies: Vec<String> = response
        .headers()
        .get_all("set-cookie")
        .iter()
        .filter_map(|value| value.to_str().ok().map(str::to_owned))
        .collect();
    let parsed: SignInBody = read_response(response)?;
    if !matches!(parsed.user.role.as_str(), "owner" | "staff") {
        return Err(AuthError::WrongRole(parsed.user.role));
    }
    let cookie = session_cookie_from_set_cookie(&cookies)
        .ok_or_else(|| AuthError::Unexpected("no session cookie in the response".into()))?;
    Ok(Session {
        cookie,
        oauth: None,
        user_id: parsed.user.id,
        name: parsed.user.name,
        email: parsed.user.email,
        role: parsed.user.role,
    })
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
        read_sign_in(&mut resp)
    }
    fn authorize(&self, session: &mut Session) -> Result<Vec<(String, String)>, AuthError> {
        if let Some(tokens) = session.oauth.as_mut() {
            if chrono::Utc::now().timestamp() + 30 >= tokens.expires_at {
                if let Some(device) = &tokens.device {
                    (tokens.access_token, tokens.expires_at) = self.renew_device(device)?;
                } else {
                    *tokens = self.request_token([
                        ("grant_type", "refresh_token"),
                        ("client_id", DESKTOP_CLIENT_ID),
                        ("refresh_token", &tokens.refresh_token),
                        ("resource", &format!("{}/api/auth/desktop", self.base_url)),
                    ])?;
                }
            }
            Ok(vec![(
                "Authorization".to_owned(),
                format!("Bearer {}", tokens.access_token),
            )])
        } else {
            Ok(vec![("Cookie".to_owned(), session.cookie.clone())])
        }
    }

    fn validate(&self, session: &Session) -> Result<bool, AuthError> {
        if session.oauth.is_some() {
            // The transport validates and rotates OAuth using the shared live session.
            return Ok(true);
        }
        match self.viewer("Cookie", &session.cookie) {
            Ok(user) => Ok(user.id == session.user_id && user.role == session.role),
            Err(AuthError::InvalidCredentials | AuthError::WrongRole(_)) => Ok(false),
            Err(error) => Err(error),
        }
    }
    fn sign_out(&self, session: &Session) {
        if let Some(tokens) = &session.oauth {
            if tokens.device.is_none() {
                self.revoke(tokens);
            }
            return;
        }
        let _ = self
            .agent
            .post(&format!("{}/api/auth/sign-out", self.base_url))
            .header("Cookie", &session.cookie)
            .header("Origin", &self.base_url)
            .content_type("application/json")
            .send("{}");
    }
}

const TIMEOUT: Duration = Duration::from_secs(20);

#[cfg(test)]
mod tests;
