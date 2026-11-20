use super::*;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant};

#[derive(Deserialize)]
struct Ticket {
    ticket: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserWorkspace {
    Waitlist,
    Clients,
    Services,
    Staff,
    Resources,
    Sales,
    Transactions,
    Inventory,
    Benefits,
    Reports,
    Commissions,
    Marketing,
    Reputation,
    Settings,
    Whatsapp,
    #[serde(other)]
    Unknown,
}

pub struct BrowserHandoff {
    listener: TcpListener,
    origin: String,
    path: String,
    cloud_origin: String,
    ticket: String,
}

impl BetterAuthSession {
    /// Use the linked device key to request a browser session without exposing a bearer token.
    pub fn begin_browser_calendar(
        &self,
        session: &Session,
        calendar: &url::Url,
    ) -> Result<Option<BrowserHandoff>, AuthError> {
        if calendar.origin().ascii_serialization() != self.base_url
            || calendar.path() != "/admin/calendar"
        {
            return Err(AuthError::Unexpected("Invalid calendar destination".into()));
        }
        let calendar: std::collections::HashMap<_, _> = calendar.query_pairs().collect();
        let date = calendar
            .get("date")
            .map(|value| value.as_ref())
            .unwrap_or("");
        let view = calendar
            .get("view")
            .map(|value| value.as_ref())
            .unwrap_or("");
        let staff = calendar.get("staff").map(|value| value.as_ref());
        let mut target = serde_json::json!({ "date": date, "view": view });
        if let Some(staff) = staff {
            target["staff"] = serde_json::json!(staff);
        }
        self.begin_browser_handoff(
            session,
            serde_json::json!({ "calendar": target }),
            &[date, view, staff.unwrap_or("")],
        )
    }

    pub fn begin_browser_workspace(
        &self,
        session: &Session,
        workspace: BrowserWorkspace,
    ) -> Result<Option<BrowserHandoff>, AuthError> {
        let workspace = serde_json::json!(workspace);
        let name = workspace
            .as_str()
            .filter(|name| *name != "unknown")
            .ok_or_else(|| AuthError::Unexpected("Invalid workspace destination".into()))?;
        self.begin_browser_handoff(
            session,
            serde_json::json!({ "workspace": name }),
            &["workspace", name],
        )
    }

    /// Open the exact receipt under the web session for the signed-in operator.
    pub fn begin_browser_receipt(
        &self,
        session: &Session,
        receipt: uuid::Uuid,
    ) -> Result<Option<BrowserHandoff>, AuthError> {
        let receipt = receipt.to_string();
        self.begin_browser_handoff(
            session,
            serde_json::json!({ "receipt": receipt }),
            &["receipt", &receipt],
        )
    }

    fn begin_browser_handoff(
        &self,
        session: &Session,
        mut body: serde_json::Value,
        fields: &[&str],
    ) -> Result<Option<BrowserHandoff>, AuthError> {
        let device = session
            .oauth
            .as_ref()
            .and_then(|value| value.device.as_ref());
        if device.is_none() && session.cookie.is_empty() {
            return Ok(None);
        }
        let listener =
            TcpListener::bind("127.0.0.1:0").map_err(|e| AuthError::Network(e.to_string()))?;
        listener
            .set_nonblocking(true)
            .map_err(|e| AuthError::Network(e.to_string()))?;
        let port = listener
            .local_addr()
            .map_err(|e| AuthError::Network(e.to_string()))?
            .port();
        let origin = format!("http://127.0.0.1:{port}");
        body["origin"] = serde_json::json!(origin);
        let mut response = if let Some(device) = device {
            let mut binding = vec![origin.as_str()];
            binding.extend_from_slice(fields);
            self.send_device_proof(device, "browser-ticket", &binding, body)?
        } else {
            self.agent
                .post(&format!(
                    "{}/api/auth/desktop/browser-ticket",
                    self.base_url
                ))
                .header("Origin", &self.base_url)
                .header("Cookie", &session.cookie)
                .content_type("application/json")
                .send(body.to_string())
                .map_err(|e| AuthError::Network(e.to_string()))?
        };
        if response.status().as_u16() != 200 {
            return Ok(None);
        }
        let Ticket { ticket } = read_response(&mut response)?;
        if ticket.len() != 43
            || !ticket
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err(AuthError::Unexpected("Invalid browser ticket".into()));
        }
        Ok(Some(BrowserHandoff {
            listener,
            origin,
            path: format!("/{}", crate::pkce::new_verifier()),
            cloud_origin: self.base_url.clone(),
            ticket,
        }))
    }
}

impl BrowserHandoff {
    pub fn url(&self) -> String {
        format!("{}{}", self.origin, self.path)
    }

    pub fn serve(self) -> bool {
        let deadline = Instant::now() + Duration::from_secs(60);
        while Instant::now() < deadline {
            let mut stream = match self.listener.accept() {
                Ok((stream, _)) => stream,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(25));
                    continue;
                }
                Err(_) => return false,
            };
            if stream.set_nonblocking(false).is_err()
                || stream
                    .set_read_timeout(Some(Duration::from_millis(250)))
                    .is_err()
                || stream
                    .set_write_timeout(Some(Duration::from_secs(1)))
                    .is_err()
            {
                continue;
            }
            let mut incoming = BufReader::new((&stream).take(4096));
            let mut line = String::new();
            if incoming.read_line(&mut line).is_err()
                || line
                    .split_whitespace()
                    .take(2)
                    .ne(["GET", self.path.as_str()])
            {
                let _ = stream.write_all(
                    b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                );
                continue;
            }
            // Read the bounded request headers before responding so the browser receives a clean EOF.
            loop {
                line.clear();
                match incoming.read_line(&mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) if line == "\r\n" => break,
                    Ok(_) => {}
                }
            }
            let nonce = crate::pkce::new_verifier();
            let cloud = &self.cloud_origin;
            let body = format!(
                r#"<!doctype html><html lang="es"><meta charset="utf-8"><title>Citame</title>
<form id="handoff" method="post" action="{cloud}/api/auth/desktop/browser">
<input type="hidden" name="ticket" value="{}"><button type="submit">Continuar a Citame</button>
</form><script nonce="{nonce}">document.getElementById('handoff').requestSubmit();</script></html>"#,
                self.ticket,
            );
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nReferrer-Policy: origin\r\nContent-Security-Policy: default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action {cloud}; script-src 'nonce-{nonce}'\r\nX-Content-Type-Options: nosniff\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len(),
            );
            return stream.write_all(response.as_bytes()).is_ok();
        }
        false
    }
}
