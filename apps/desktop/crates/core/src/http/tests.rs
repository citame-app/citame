use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, RwLock, mpsc};

use super::*;
use crate::auth::{BetterAuthSession, Credentials, Session};

/// Serves the given raw HTTP responses, one per connection, and records the requests.
fn serve(responses: Vec<String>) -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(vec![]));
    let log = seen.clone();
    std::thread::spawn(move || {
        for resp in responses {
            let Ok((mut s, _)) = listener.accept() else { return };
            let mut buf = vec![];
            let mut chunk = [0u8; 4096];
            loop {
                let n = s.read(&mut chunk).unwrap_or(0);
                buf.extend_from_slice(&chunk[..n]);
                let text = String::from_utf8_lossy(&buf).to_string();
                if let Some(h) = text.find("\r\n\r\n") {
                    let len = text[..h]
                        .lines()
                        .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
                        .unwrap_or(0);
                    if buf.len() >= h + 4 + len {
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
            }
            log.lock().unwrap().push(String::from_utf8_lossy(&buf).to_string());
            let _ = s.write_all(resp.as_bytes());
            let _ = s.flush();
        }
    });
    (base, seen)
}

fn http(status: &str, headers: &[&str], body: &str) -> String {
    let extra: String = headers.iter().map(|h| format!("{h}\r\n")).collect();
    format!("HTTP/1.1 {status}\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
}

fn signed_in(base: &str) -> HttpTransport {
    let session: SessionHandle = Arc::new(RwLock::new(Some(Session {
        cookie: "better-auth.session_token=tok%3D".into(),
        user_id: "u".into(),
        name: "n".into(),
        email: "e".into(),
        role: "owner".into(),
    })));
    HttpTransport::new(base, session, Arc::new(BetterAuthSession::new(base)))
}

fn req() -> PushRequest {
    PushRequest {
        device_id: "dev-1".into(),
        mutations: vec![WireMutation {
            mutation_id: "01a1d81f-2231-75bd-ba65-bc41f42803e9".into(),
            created_at: "2026-03-09T11:58:03.120Z".into(),
            kind: "client.create".into(),
            payload: serde_json::json!({"id": "c1", "name": "Lucia"}),
        }],
    }
}

#[test]
fn push_posts_json_with_the_session_cookie_and_parses_results() {
    let body = r#"{"results":[{"mutationId":"01a1d81f-2231-75bd-ba65-bc41f42803e9","status":"applied","appliedSeq":12,"replayed":false}],"headSeq":12}"#;
    let (base, seen) = serve(vec![http("200 OK", &["Content-Type: application/json"], body)]);
    let r = signed_in(&base).push(&req()).unwrap();
    assert_eq!(r.head_seq, 12);
    assert!(matches!(&r.results[0], MutationResult::Applied { applied_seq: Some(12), .. }));
    let sent = seen.lock().unwrap()[0].clone();
    assert!(sent.starts_with("POST /sync/push HTTP/1.1"), "{sent}");
    assert!(sent.to_lowercase().contains("cookie: better-auth.session_token=tok%3d"), "{sent}");
    assert!(sent.to_lowercase().contains("content-type: application/json"));
    assert!(sent.contains("\"deviceId\":\"dev-1\"") && sent.contains("\"mutationId\":\"01a1d81f-2231-75bd-ba65-bc41f42803e9\""));
}

#[test]
fn pull_sends_cursor_and_limit_and_parses_the_page() {
    let body = r#"{"changes":[{"seq":3,"entity":"time_off","id":"t1","op":"delete","data":null}],"nextCursor":3,"hasMore":true,"headSeq":9}"#;
    let (base, seen) = serve(vec![http("200 OK", &["Content-Type: application/json"], body)]);
    let p = signed_in(&base).pull(2, 200).unwrap();
    assert_eq!((p.next_cursor, p.has_more, p.head_seq), (3, true, 9));
    assert_eq!(p.changes[0].op, "delete");
    assert!(seen.lock().unwrap()[0].starts_with("GET /sync/pull?since=2&limit=200 HTTP/1.1"));
}

fn status_of(code: &str, headers: &[&str], body: &str, pull: bool) -> TransportError {
    let (base, _) = serve(vec![http(code, headers, body)]);
    let t = signed_in(&base);
    if pull { t.pull(0, 10).unwrap_err() } else { t.push(&req()).unwrap_err() }
}

#[test]
fn error_statuses_follow_the_protocol_table() {
    assert_eq!(status_of("401 Unauthorized", &[], r#"{"error":{"code":"unauthorized","message":"x"}}"#, false), TransportError::Unauthorized);
    assert!(matches!(status_of("403 Forbidden", &[], r#"{"error":{"code":"forbidden","message":"nope"}}"#, false), TransportError::Forbidden(m) if m.contains("nope")));
    assert_eq!(status_of("429 Too Many Requests", &["Retry-After: 7"], "{}", false), TransportError::RateLimited(Some(Duration::from_secs(7))));
    assert_eq!(status_of("429 Too Many Requests", &[], "{}", true), TransportError::RateLimited(None));
    assert!(matches!(status_of("500 Internal Server Error", &[], "", false), TransportError::Server(_)));
    assert!(matches!(status_of("502 Bad Gateway", &[], "<html>", true), TransportError::Server(_)));
    assert!(matches!(status_of("400 Bad Request", &[], r#"{"error":{"code":"validation_error","message":"too many"}}"#, false), TransportError::BadRequest(m) if m.contains("too many")));
    assert_eq!(status_of("409 Conflict", &[], r#"{"error":{"code":"invalid_state","message":"ahead"}}"#, true), TransportError::CursorAhead);
}

#[test]
fn a_garbled_success_body_is_treated_like_a_server_failure() {
    assert!(matches!(status_of("200 OK", &[], "<html>captive portal</html>", false), TransportError::Server(_)));
}

#[test]
fn classify_is_pure() {
    assert_eq!(classify_status(401, None, "", true), TransportError::Unauthorized);
    assert_eq!(classify_status(429, Some("Wed, 21 Oct 2026 07:28:00 GMT"), "", true), TransportError::RateLimited(None));
}

#[test]
fn an_unreachable_server_is_offline() {
    let port = { TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port() };
    let e = signed_in(&format!("http://127.0.0.1:{port}")).pull(0, 10).unwrap_err();
    assert!(matches!(e, TransportError::Offline(_)), "{e:?}");
}

#[test]
fn without_a_session_nothing_goes_on_the_wire() {
    let session: SessionHandle = Arc::new(RwLock::new(None));
    let t = HttpTransport::new("http://127.0.0.1:9", session, Arc::new(BetterAuthSession::new("http://127.0.0.1:9")));
    assert_eq!(t.pull(0, 10).unwrap_err(), TransportError::Unauthorized);
}

#[test]
fn sign_in_returns_the_session_cookie_and_user() {
    let body = r#"{"redirect":false,"token":"t","user":{"id":"u1","name":"Owner","email":"owner@example.com","role":"owner"}}"#;
    let (base, seen) = serve(vec![http(
        "200 OK",
        &["Content-Type: application/json", "Set-Cookie: better-auth.session_token=abc.def%3D; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax"],
        body,
    )]);
    let s = BetterAuthSession::new(&base)
        .sign_in(&Credentials { email: "owner@example.com".into(), password: "pw".into() })
        .unwrap();
    assert_eq!((s.cookie.as_str(), s.role.as_str(), s.user_id.as_str()), ("better-auth.session_token=abc.def%3D", "owner", "u1"));
    let sent = seen.lock().unwrap()[0].clone();
    assert!(sent.starts_with("POST /api/auth/sign-in/email HTTP/1.1"));
    assert!(sent.contains("\"email\":\"owner@example.com\"") && sent.contains("\"password\":\"pw\""));
}

#[test]
fn sign_in_failures_are_distinguished() {
    let creds = Credentials { email: "a@b.c".into(), password: "x".into() };
    let (base, _) = serve(vec![http("401 Unauthorized", &[], r#"{"code":"INVALID_EMAIL_OR_PASSWORD","message":"Invalid email or password"}"#)]);
    assert_eq!(BetterAuthSession::new(&base).sign_in(&creds).unwrap_err(), crate::auth::AuthError::InvalidCredentials);

    let body = r#"{"user":{"id":"u2","name":"Cli","email":"a@b.c","role":"client"}}"#;
    let (base, _) = serve(vec![http("200 OK", &["Set-Cookie: better-auth.session_token=z; Path=/"], body)]);
    assert!(matches!(BetterAuthSession::new(&base).sign_in(&creds).unwrap_err(), crate::auth::AuthError::WrongRole(r) if r == "client"));

    let port = { TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port() };
    assert!(matches!(BetterAuthSession::new(&format!("http://127.0.0.1:{port}")).sign_in(&creds).unwrap_err(), crate::auth::AuthError::Network(_)));
}

#[test]
fn validate_asks_the_server_whether_the_session_is_alive() {
    let s = Session { cookie: "better-auth.session_token=a".into(), user_id: "u".into(), name: "n".into(), email: "e".into(), role: "owner".into() };
    let (base, seen) = serve(vec![http("200 OK", &[], r#"{"role":"owner"}"#), http("401 Unauthorized", &[], "{}")]);
    let a = BetterAuthSession::new(&base);
    assert_eq!(a.validate(&s), Ok(true));
    assert_eq!(a.validate(&s), Ok(false));
    assert!(seen.lock().unwrap()[0].starts_with("GET /me HTTP/1.1"));
}

fn sse(body: &str) -> String {
    format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n{body}")
}

#[test]
fn the_stream_forwards_change_events_and_ignores_pings() {
    let body = "event: change\nid: 5\ndata: {\"seq\":5}\n\n: ping\n\nevent: change\nid: 6\ndata: {\"seq\":6}\n\n";
    let (base, seen) = serve(vec![sse(body)]);
    let t = signed_in(&base);
    let (mut connected, mut seqs) = (0, vec![]);
    let end = stream_once(&t, &mut || connected += 1, &mut |s| seqs.push(s)).unwrap();
    assert_eq!(end, StreamEnd::Closed);
    assert_eq!((connected, seqs), (1, vec![5, 6]));
    let sent = seen.lock().unwrap()[0].to_lowercase();
    assert!(sent.starts_with("get /sync/stream http/1.1") && sent.contains("accept: text/event-stream") && sent.contains("cookie: better-auth.session_token=tok%3d"));
}

#[test]
fn the_stream_reports_auth_and_rate_limit_errors() {
    let (base, _) = serve(vec![http("401 Unauthorized", &[], "{}")]);
    assert_eq!(stream_once(&signed_in(&base), &mut || {}, &mut |_| {}).unwrap_err(), TransportError::Unauthorized);
    let (base, _) = serve(vec![http("429 Too Many Requests", &["Retry-After: 3"], "{}")]);
    assert_eq!(stream_once(&signed_in(&base), &mut || {}, &mut |_| {}).unwrap_err(), TransportError::RateLimited(Some(Duration::from_secs(3))));
}

#[test]
fn the_listener_reconnects_after_the_stream_closes_and_wakes_the_runner() {
    let first = sse("event: change\nid: 5\ndata: {\"seq\":5}\n\n");
    let second = sse("event: change\nid: 7\ndata: {\"seq\":7}\n\n");
    let (base, _) = serve(vec![first, second]);
    let t = Arc::new(signed_in(&base));
    let (tx, rx) = mpsc::channel();
    let live = Arc::new(AtomicBool::new(false));
    let stop = Arc::new(AtomicBool::new(false));
    let h = spawn_stream_listener(t, tx, live.clone(), stop.clone());
    let got: Vec<_> = (0..2).map(|_| rx.recv_timeout(Duration::from_secs(10)).unwrap()).collect();
    assert_eq!(got, vec![Wake::Nudge(5), Wake::Nudge(7)]);
    stop.store(true, Ordering::SeqCst);
    h.join().unwrap();
    assert!(!live.load(Ordering::SeqCst));
}
