use super::*;

fn session() -> Session {
    Session {
        cookie: "better-auth.session_token=abc.def%3D".into(),
        user_id: "u1".into(),
        name: "Owner".into(),
        email: "owner@example.com".into(),
        role: "owner".into(),
    }
}

#[test]
fn memory_store_round_trips() {
    let s = MemoryTokenStore::default();
    assert_eq!(s.load().unwrap(), None);
    s.save(&session()).unwrap();
    assert_eq!(s.load().unwrap(), Some(session()));
    s.clear().unwrap();
    assert_eq!(s.load().unwrap(), None);
}

#[test]
fn file_store_round_trips_clears_and_is_owner_only() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("nested").join("session.json");
    let s = FileTokenStore::new(&path);
    assert_eq!(s.load().unwrap(), None);
    s.save(&session()).unwrap();
    assert_eq!(FileTokenStore::new(&path).load().unwrap(), Some(session()));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    s.clear().unwrap();
    s.clear().unwrap();
    assert_eq!(s.load().unwrap(), None);
}

#[test]
fn a_corrupt_session_file_means_signed_out_not_a_crash() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("session.json");
    std::fs::write(&path, "{ not json").unwrap();
    assert_eq!(FileTokenStore::new(&path).load().unwrap(), None);
}

#[test]
fn the_session_cookie_is_picked_out_of_set_cookie_headers() {
    let headers = vec![
        "theme=dark; Path=/".to_string(),
        "better-auth.session_token=Ku8e.gTkV%3D; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax"
            .to_string(),
    ];
    assert_eq!(
        session_cookie_from_set_cookie(&headers).as_deref(),
        Some("better-auth.session_token=Ku8e.gTkV%3D")
    );
    let secure = vec!["__Secure-better-auth.session_token=xyz; Secure; HttpOnly".to_string()];
    assert_eq!(
        session_cookie_from_set_cookie(&secure).as_deref(),
        Some("__Secure-better-auth.session_token=xyz")
    );
    assert_eq!(
        session_cookie_from_set_cookie(&["other=1".to_string()]),
        None
    );
}

#[test]
fn authorize_sends_the_cookie() {
    let a = BetterAuthSession::new("http://localhost:3000");
    assert_eq!(
        a.authorize(&session()),
        vec![(
            "Cookie".to_string(),
            "better-auth.session_token=abc.def%3D".to_string()
        )]
    );
    assert_eq!(a.id(), "better-auth-session");
}
