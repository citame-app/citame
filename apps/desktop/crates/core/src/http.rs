//! HTTP transport for the sync protocol and the SSE nudge listener.

use std::io::{BufRead, BufReader};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::thread::JoinHandle;
use std::time::Duration;

use crate::auth::{AuthProvider, SessionHandle};
use crate::backoff::Backoff;
use crate::model::*;
use crate::runner::Wake;
use crate::sse::{SseParser, nudge_seq};
use crate::sync::{Transport, TransportError};

pub struct HttpTransport {
    base_url: String,
    agent: ureq::Agent,
    stream_agent: ureq::Agent,
    session: SessionHandle,
    auth: Arc<dyn AuthProvider>,
}

/// The stream is reconnected at least this often. ureq bounds the whole body, not each read,
/// so this doubles as dead-connection detection (the server pings every 15 s).
const STREAM_BODY_BUDGET: Duration = Duration::from_secs(90);

impl HttpTransport {
    pub fn new(base_url: &str, session: SessionHandle, auth: Arc<dyn AuthProvider>) -> Self {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(Duration::from_secs(30)))
            .build()
            .into();
        let stream_agent: ureq::Agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_connect(Some(Duration::from_secs(10)))
            .timeout_recv_response(Some(Duration::from_secs(15)))
            .timeout_recv_body(Some(STREAM_BODY_BUDGET))
            .build()
            .into();
        Self {
            base_url: base_url.trim_end_matches('/').to_owned(),
            agent,
            stream_agent,
            session,
            auth,
        }
    }

    fn headers(&self) -> Result<Vec<(String, String)>, TransportError> {
        let guard = self.session.read().expect("session lock");
        let session = guard.as_ref().ok_or(TransportError::Unauthorized)?;
        Ok(self.auth.authorize(session))
    }

    fn get(
        &self,
        agent: &ureq::Agent,
        path: &str,
        accept: Option<&str>,
    ) -> Result<ureq::http::Response<ureq::Body>, TransportError> {
        let mut req = agent.get(&format!("{}{path}", self.base_url));
        for (k, v) in self.headers()? {
            req = req.header(k, v);
        }
        if let Some(a) = accept {
            req = req.header("Accept", a);
        }
        req.call()
            .map_err(|e| TransportError::Offline(e.to_string()))
    }
}

fn error_message(body: &str) -> String {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| {
            v.pointer("/error/message")
                .and_then(|m| m.as_str().map(str::to_owned))
        })
        .unwrap_or_else(|| body.chars().take(200).collect())
}

/// Maps an error response to the protocol's error table.
pub fn classify_status(
    status: u16,
    retry_after: Option<&str>,
    body: &str,
    is_pull: bool,
) -> TransportError {
    match status {
        401 => TransportError::Unauthorized,
        403 => TransportError::Forbidden(error_message(body)),
        409 if is_pull => TransportError::CursorAhead,
        429 => TransportError::RateLimited(
            retry_after
                .and_then(|v| v.trim().parse::<u64>().ok())
                .map(Duration::from_secs),
        ),
        400..=499 => TransportError::BadRequest(error_message(body)),
        _ => TransportError::Server(format!("HTTP {status}: {}", error_message(body))),
    }
}

fn read_response<T: serde::de::DeserializeOwned>(
    mut resp: ureq::http::Response<ureq::Body>,
    is_pull: bool,
) -> Result<T, TransportError> {
    let status = resp.status().as_u16();
    let retry_after = resp
        .headers()
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let body = resp
        .body_mut()
        .read_to_string()
        .map_err(|e| TransportError::Offline(e.to_string()))?;
    if status != 200 {
        return Err(classify_status(
            status,
            retry_after.as_deref(),
            &body,
            is_pull,
        ));
    }
    serde_json::from_str(&body).map_err(|e| {
        TransportError::Server(format!(
            "unreadable response ({e}): {}",
            body.chars().take(80).collect::<String>()
        ))
    })
}

impl Transport for HttpTransport {
    fn push(&self, request: &PushRequest) -> Result<PushResponse, TransportError> {
        let body = serde_json::to_string(request)
            .map_err(|e| TransportError::BadRequest(e.to_string()))?;
        let mut req = self.agent.post(&format!("{}/sync/push", self.base_url));
        for (k, v) in self.headers()? {
            req = req.header(k, v);
        }
        let resp = req
            .content_type("application/json")
            .send(body)
            .map_err(|e| TransportError::Offline(e.to_string()))?;
        read_response(resp, false)
    }

    fn pull(&self, since: i64, limit: u32) -> Result<PullResponse, TransportError> {
        let resp = self.get(
            &self.agent,
            &format!("/sync/pull?since={since}&limit={limit}"),
            None,
        )?;
        read_response(resp, true)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum StreamEnd {
    /// The server closed the stream (shutdown or the periodic reconnect).
    Closed,
    /// The caller asked to stop.
    Stopped,
}

/// Opens `GET /sync/stream` once and forwards every `change` event until the stream ends.
pub fn stream_once(
    transport: &HttpTransport,
    on_connected: &mut dyn FnMut(),
    on_nudge: &mut dyn FnMut(i64),
) -> Result<StreamEnd, TransportError> {
    stream_until(transport, &AtomicBool::new(false), on_connected, on_nudge)
}

fn stream_until(
    transport: &HttpTransport,
    stop: &AtomicBool,
    on_connected: &mut dyn FnMut(),
    on_nudge: &mut dyn FnMut(i64),
) -> Result<StreamEnd, TransportError> {
    let mut resp = transport.get(
        &transport.stream_agent,
        "/sync/stream",
        Some("text/event-stream"),
    )?;
    let status = resp.status().as_u16();
    if status != 200 {
        let retry_after = resp
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let body = resp.body_mut().read_to_string().unwrap_or_default();
        return Err(classify_status(
            status,
            retry_after.as_deref(),
            &body,
            false,
        ));
    }
    on_connected();
    let mut parser = SseParser::default();
    let reader = BufReader::new(resp.into_body().into_reader());
    for line in reader.lines() {
        if stop.load(Ordering::SeqCst) {
            return Ok(StreamEnd::Stopped);
        }
        // A read error mid-stream (budget exhausted, connection dropped) is a normal end.
        let Ok(line) = line else {
            return Ok(StreamEnd::Closed);
        };
        if let Some(event) = parser.feed_line(line.trim_end_matches('\r'))
            && event.event.as_deref() == Some("change")
            && let Some(seq) = nudge_seq(&event)
        {
            on_nudge(seq);
        }
    }
    Ok(StreamEnd::Closed)
}

fn sleep_unless_stopped(total: Duration, stop: &AtomicBool) {
    let step = Duration::from_millis(50);
    let mut left = total;
    while !left.is_zero() && !stop.load(Ordering::SeqCst) {
        let s = step.min(left);
        std::thread::sleep(s);
        left -= s;
    }
}

/// Keeps the nudge stream alive until `stop` is set: reconnects with backoff, reports liveness.
pub fn spawn_stream_listener(
    transport: Arc<HttpTransport>,
    wakes: Sender<Wake>,
    live: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
) -> JoinHandle<()> {
    std::thread::Builder::new()
        .name("sob-sse".into())
        .spawn(move || {
            let mut backoff = Backoff::default();
            while !stop.load(Ordering::SeqCst) {
                let mut connected = false;
                let mut gone = false;
                let result = stream_until(
                    &transport,
                    &stop,
                    &mut || {
                        connected = true;
                        live.store(true, Ordering::SeqCst);
                    },
                    &mut |seq| {
                        if wakes.send(Wake::Nudge(seq)).is_err() {
                            gone = true;
                        }
                    },
                );
                live.store(false, Ordering::SeqCst);
                if gone {
                    return;
                }
                match result {
                    Ok(StreamEnd::Stopped) => return,
                    Ok(StreamEnd::Closed) => {
                        if connected {
                            backoff.reset();
                        }
                        sleep_unless_stopped(Duration::from_millis(250), &stop);
                    }
                    Err(e) => {
                        let retry_after = match e {
                            TransportError::RateLimited(after) => after,
                            _ => None,
                        };
                        let delay = Backoff::at_least(backoff.next_delay(), retry_after);
                        sleep_unless_stopped(delay, &stop);
                    }
                }
            }
        })
        .expect("spawn stream thread")
}

#[cfg(test)]
mod tests;
