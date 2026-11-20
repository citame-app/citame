//! Optional interactive check. Run it against an isolated Citame stack with an owner account.
use std::sync::{Arc, RwLock, atomic::AtomicBool};

use sob_core::auth::{AuthError, AuthProvider, BetterAuthSession, FileTokenStore, TokenStore};
use sob_core::http::HttpTransport;
use sob_core::ops;
use sob_core::store::Store;
use sob_core::sync;

#[test]
#[ignore = "opens a real OAuth flow and waits for browser sign-in on the synthetic stack"]
fn browser_oauth_sign_in_authorizes_native_push_and_pull() {
    let base = std::env::var("SOB_TEST_API_URL").expect("Set the synthetic Citame origin");
    let auth = Arc::new(BetterAuthSession::new(&base));
    let flow = auth.begin_browser_sign_in().unwrap();
    eprintln!("Authorize at {}", flow.url);
    let session = auth
        .complete_browser_sign_in(flow, &AtomicBool::new(false))
        .unwrap();
    assert_eq!(session.role, "owner");
    assert!(session.cookie.is_empty());
    assert!(session.has_device_link());
    let dir = tempfile::tempdir().unwrap();
    let session_path = dir.path().join("session.json");
    let tokens = FileTokenStore::new(session_path.clone());
    tokens.save(&session).unwrap();
    let mut saved: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&session_path).unwrap()).unwrap();
    saved["oauth"]["expires_at"] = 0.into();
    std::fs::write(&session_path, serde_json::to_vec(&saved).unwrap()).unwrap();
    let session = tokens.load().unwrap().unwrap();
    let session = Arc::new(RwLock::new(Some(session)));
    let transport = HttpTransport::new(&base, session.clone(), auth.clone());
    let replica_path = dir.path().join("replica.db");
    let mut store = Store::open(&replica_path).unwrap();
    sync::sync_cycle(&mut store, &transport).unwrap();
    let id = ops::create_client(&mut store, "OAuth synthetic contact", None).unwrap();
    assert_eq!(store.outbox_len().unwrap(), 1);
    drop(store);

    let mut store = Store::open(&replica_path).unwrap();
    assert_eq!(store.outbox_len().unwrap(), 1);
    let report = sync::sync_cycle(&mut store, &transport).unwrap();
    assert_eq!(report.push.applied, 1);
    assert_eq!(store.outbox_len().unwrap(), 0);

    let mut observer = Store::open_in_memory().unwrap();
    sync::pull_all(&mut observer, &transport).unwrap();
    assert!(
        observer
            .clients()
            .unwrap()
            .iter()
            .any(|client| client.id == id)
    );
    let remote_id =
        ops::create_client(&mut observer, "OAuth second replica contact", None).unwrap();
    assert_eq!(
        sync::sync_cycle(&mut observer, &transport)
            .unwrap()
            .push
            .applied,
        1
    );
    sync::pull_all(&mut store, &transport).unwrap();
    assert!(
        store
            .clients()
            .unwrap()
            .iter()
            .any(|client| client.id == remote_id)
    );

    let mut linked = session.read().unwrap().clone().unwrap();
    auth.disconnect_device(&linked).unwrap();
    auth.disconnect_device(&linked).unwrap();
    let mut revoked = serde_json::to_value(&linked).unwrap();
    revoked["oauth"]["expires_at"] = 0.into();
    linked = serde_json::from_value(revoked).unwrap();
    assert_eq!(
        auth.authorize(&mut linked),
        Err(AuthError::InvalidCredentials)
    );
}
