//! OAuth 2.1 Authorization Code + PKCE building blocks with a loopback redirect (RFC 7636,
//! RFC 8252). Not wired to the API yet: the OAuth provider arrives in Phase 6 (ADR 0008).

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant};

fn pct_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn pct_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => match u8::from_str_radix(&s[i + 1..i + 3], 16) {
                Ok(v) => {
                    out.push(v);
                    i += 3;
                }
                Err(_) => {
                    out.push(b'%');
                    i += 1;
                }
            },
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `S256` code challenge for a verifier.
pub fn challenge_s256(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// A fresh high-entropy verifier (43 characters, unreserved alphabet).
pub fn new_verifier() -> String {
    let mut buf = [0u8; 32];
    getrandom::fill(&mut buf).expect("system randomness");
    URL_SAFE_NO_PAD.encode(buf)
}

#[derive(Debug, PartialEq, Eq)]
pub struct AuthorizationResponse {
    pub code: String,
    pub state: String,
}

/// Parses the request line of the loopback redirect (`GET /callback?code=..&state=.. HTTP/1.1`).
pub fn parse_redirect_request_line(line: &str) -> Result<AuthorizationResponse, String> {
    let target = line
        .split_whitespace()
        .nth(1)
        .ok_or("malformed request line")?;
    let query = target.split_once('?').map(|(_, q)| q).unwrap_or("");
    let (mut code, mut state, mut error) = (None, None, None);
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        match k {
            "code" => code = Some(pct_decode(v)),
            "state" => state = Some(pct_decode(v)),
            "error" => error = Some(pct_decode(v)),
            _ => {}
        }
    }
    if let Some(e) = error {
        return Err(format!("authorization failed: {e}"));
    }
    match (code, state) {
        (Some(code), Some(state)) => Ok(AuthorizationResponse { code, state }),
        _ => Err("redirect without code or state".into()),
    }
}

/// Builds the authorization URL to open in the system browser.
pub fn authorization_url(
    authorize_endpoint: &str,
    client_id: &str,
    redirect_uri: &str,
    state: &str,
    challenge: &str,
) -> String {
    format!(
        "{authorize_endpoint}?response_type=code&client_id={}&redirect_uri={}&state={}&code_challenge={challenge}&code_challenge_method=S256",
        pct_encode(client_id),
        pct_encode(redirect_uri),
        pct_encode(state),
    )
}

/// One-shot loopback listener on `127.0.0.1:<ephemeral port>`.
pub struct LoopbackReceiver {
    listener: std::net::TcpListener,
}

impl LoopbackReceiver {
    pub fn bind() -> std::io::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        listener.set_nonblocking(true)?;
        Ok(Self { listener })
    }

    pub fn redirect_uri(&self) -> String {
        let port = self.listener.local_addr().map(|a| a.port()).unwrap_or(0);
        format!("http://127.0.0.1:{port}/callback")
    }

    /// Blocks until the browser hits the redirect, answers with a small page, and checks `state`.
    pub fn wait(
        self,
        expected_state: &str,
        timeout: Duration,
    ) -> Result<AuthorizationResponse, String> {
        let deadline = Instant::now() + timeout;
        let stream = loop {
            match self.listener.accept() {
                Ok((stream, _)) => break stream,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if Instant::now() >= deadline {
                        return Err("timed out waiting for the browser".into());
                    }
                    std::thread::sleep(Duration::from_millis(25));
                }
                Err(e) => return Err(e.to_string()),
            }
        };
        stream.set_nonblocking(false).map_err(|e| e.to_string())?;
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .map_err(|e| e.to_string())?;
        let mut line = String::new();
        BufReader::new(&stream)
            .read_line(&mut line)
            .map_err(|e| e.to_string())?;
        let parsed = parse_redirect_request_line(&line);
        let body = if parsed.is_ok() {
            "<html><body>Signed in. You can close this tab.</body></html>"
        } else {
            "<html><body>Sign-in failed. You can close this tab.</body></html>"
        };
        let mut stream = stream;
        let _ = write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let resp = parsed?;
        if resp.state != expected_state {
            return Err("state mismatch: possible CSRF, discarding the response".into());
        }
        Ok(resp)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    fn s256_matches_the_rfc_7636_appendix_b_vector() {
        assert_eq!(
            challenge_s256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn verifiers_are_unique_and_rfc_compliant() {
        let a = new_verifier();
        let b = new_verifier();
        assert_ne!(a, b);
        assert!((43..=128).contains(&a.len()));
        assert!(
            a.chars()
                .all(|c| c.is_ascii_alphanumeric() || "-._~".contains(c))
        );
    }

    #[test]
    fn parses_code_and_state_from_the_redirect() {
        let r =
            parse_redirect_request_line("GET /callback?code=abc%20d&state=xyz HTTP/1.1").unwrap();
        assert_eq!(
            r,
            AuthorizationResponse {
                code: "abc d".into(),
                state: "xyz".into()
            }
        );
    }

    #[test]
    fn redirect_error_is_surfaced() {
        let e = parse_redirect_request_line("GET /callback?error=access_denied&state=s HTTP/1.1")
            .unwrap_err();
        assert!(e.contains("access_denied"));
    }

    #[test]
    fn authorization_url_encodes_parameters() {
        let url = authorization_url(
            "http://api/authorize",
            "desktop",
            "http://127.0.0.1:5000/callback",
            "s t",
            "ch",
        );
        assert!(url.starts_with("http://api/authorize?response_type=code&client_id=desktop"));
        assert!(url.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A5000%2Fcallback"));
        assert!(url.contains("state=s%20t"));
        assert!(url.contains("code_challenge=ch&code_challenge_method=S256"));
    }

    fn browser_hit(uri: &str, query: &str) {
        let port = uri
            .rsplit(':')
            .next()
            .unwrap()
            .split('/')
            .next()
            .unwrap()
            .to_string();
        let mut s = std::net::TcpStream::connect(format!("127.0.0.1:{port}")).unwrap();
        write!(s, "GET /callback?{query} HTTP/1.1\r\nHost: x\r\n\r\n").unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).unwrap();
        assert!(out.starts_with("HTTP/1.1 200"));
    }

    #[test]
    fn loopback_receives_the_code_on_an_ephemeral_port() {
        let rx = LoopbackReceiver::bind().unwrap();
        let uri = rx.redirect_uri();
        assert!(uri.starts_with("http://127.0.0.1:") && uri.ends_with("/callback"));
        let t = std::thread::spawn(move || browser_hit(&uri, "code=C1&state=S1"));
        let got = rx.wait("S1", Duration::from_secs(5)).unwrap();
        t.join().unwrap();
        assert_eq!(got.code, "C1");
    }

    #[test]
    fn loopback_rejects_a_state_mismatch() {
        let rx = LoopbackReceiver::bind().unwrap();
        let uri = rx.redirect_uri();
        let t = std::thread::spawn(move || browser_hit(&uri, "code=C1&state=EVIL"));
        let err = rx.wait("S1", Duration::from_secs(5)).unwrap_err();
        t.join().unwrap();
        assert!(err.contains("state"));
    }

    #[test]
    fn loopback_times_out_when_nobody_comes() {
        let rx = LoopbackReceiver::bind().unwrap();
        assert!(
            rx.wait("S", Duration::from_millis(150))
                .unwrap_err()
                .contains("timed out")
        );
    }
}
