use std::io::Write;
use std::net::TcpStream;
use std::sync::{Arc, RwLock, atomic::AtomicBool};
use std::time::Duration;

use serde_json::{Value, json};
use sob_core::auth::{
    AuthProvider, BetterAuthSession, FileTokenStore, SessionHandle, TokenStore,
    session_cookie_from_set_cookie,
};
use sob_core::http::HttpTransport;
use sob_core::waitlist::WaitlistRequest;
use url::Url;

pub(super) struct ProxyDevice {
    pub base: Url,
    pub transport: HttpTransport,
    auth: Arc<BetterAuthSession>,
    session: SessionHandle,
    agent: ureq::Agent,
    _profile: tempfile::TempDir,
}

fn response_json(response: &mut ureq::http::Response<ureq::Body>) -> Value {
    serde_json::from_str(&response.body_mut().read_to_string().unwrap()).unwrap()
}

impl ProxyDevice {
    pub fn link(origin: &str, email: &str, password: &str) -> Self {
        let base = Url::parse(origin).unwrap();
        assert!(matches!(base.host_str(), Some("localhost" | "127.0.0.1")));
        assert!(
            base.origin().ascii_serialization() == origin,
            "expected a plain origin for the disposable review fixture"
        );
        let auth = Arc::new(BetterAuthSession::new(origin));
        let flow = auth.begin_browser_sign_in().unwrap();
        let request_url = Url::parse(&flow.url).unwrap();
        let callback = request_url
            .query_pairs()
            .find(|(key, _)| key == "redirect_uri")
            .map(|(_, value)| Url::parse(&value).unwrap())
            .unwrap();
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .max_redirects(0)
            .timeout_global(Some(Duration::from_secs(10)))
            .build()
            .into();

        let authorization = agent.get(&flow.url).call().unwrap();
        assert_eq!(authorization.status().as_u16(), 302);
        let sign_in = base
            .join(authorization.headers()["location"].to_str().unwrap())
            .unwrap();
        assert_eq!(sign_in.origin(), base.origin());
        assert_eq!(sign_in.path(), "/sign-in");
        let mut signed_in = agent
            .post(base.join("/api/auth/sign-in/email").unwrap().as_str())
            .header("Origin", origin)
            .content_type("application/json")
            .send(json!({ "email": email, "password": password, "oauth_query": sign_in.query().unwrap() }).to_string())
            .unwrap();
        assert_eq!(signed_in.status().as_u16(), 200);
        let cookies = signed_in
            .headers()
            .get_all("set-cookie")
            .iter()
            .map(|header| header.to_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        let next = base
            .join(response_json(&mut signed_in)["url"].as_str().unwrap())
            .unwrap();
        let next = if next.origin() == base.origin() && next.path() == "/consent" {
            let cookie = session_cookie_from_set_cookie(&cookies).expect("browser session cookie");
            let mut consent = agent
                .post(base.join("/api/auth/oauth2/consent").unwrap().as_str())
                .header("Cookie", cookie)
                .header("Origin", origin)
                .content_type("application/json")
                .send(json!({ "accept": true, "scope": "desktop:sign-in", "oauth_query": next.query().unwrap() }).to_string())
                .unwrap();
            assert_eq!(consent.status().as_u16(), 200);
            Url::parse(response_json(&mut consent)["url"].as_str().unwrap()).unwrap()
        } else {
            next
        };
        assert_eq!(next.origin(), callback.origin());
        assert_eq!(next.path(), callback.path());
        assert!(
            next.query_pairs().find(|(key, _)| key == "state")
                == request_url.query_pairs().find(|(key, _)| key == "state"),
            "the callback did not preserve the original OAuth state"
        );
        assert!(
            next.query_pairs()
                .any(|(key, value)| key == "code" && !value.is_empty())
        );

        // The signed redirect only goes to the listener created for this exact Rust flow.
        let port = callback.port().unwrap();
        let address = (std::net::Ipv4Addr::LOCALHOST, port).into();
        let mut browser = TcpStream::connect_timeout(&address, Duration::from_secs(2)).unwrap();
        write!(
            browser,
            "GET {}?{} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n",
            next.path(),
            next.query().unwrap()
        )
        .unwrap();
        let linked = auth
            .complete_browser_sign_in(flow, &AtomicBool::new(false))
            .unwrap();
        assert!(linked.cookie.is_empty());
        assert!(linked.has_device_link());
        assert_eq!(linked.role, "owner");

        // The first review request must renew from the saved device key, without a browser.
        let profile = tempfile::tempdir().unwrap();
        let tokens = Arc::new(FileTokenStore::new(profile.path().join("session.json")));
        let mut expired = serde_json::to_value(linked).unwrap();
        expired["oauth"]["access_token"] = "expired-test-token".into();
        expired["oauth"]["expires_at"] = 0.into();
        tokens
            .save(&serde_json::from_value(expired).unwrap())
            .unwrap();
        let session = Arc::new(RwLock::new(Some(tokens.load().unwrap().unwrap())));
        let transport =
            HttpTransport::new(origin, session.clone(), auth.clone()).with_token_store(tokens);
        Self {
            base,
            transport,
            auth,
            session,
            agent,
            _profile: profile,
        }
    }

    fn bearer_header(&self) -> (String, String) {
        let mut linked = self.session.read().unwrap().clone().unwrap();
        let mut headers = self.auth.authorize(&mut linked).unwrap();
        assert_eq!(headers.len(), 1);
        let header = headers.pop().unwrap();
        assert_eq!(header.0, "Authorization");
        assert!(header.1.starts_with("Bearer cd1."));
        header
    }

    pub fn assert_stale_reply(&self, id: &str, version: u32, reply: &str) {
        let (name, value) = self.bearer_header();
        let mut response = self
            .agent
            .put(
                self.base
                    .join(&format!("/api/admin/reviews/{id}/reply"))
                    .unwrap()
                    .as_str(),
            )
            .header(&name, &value)
            .content_type("application/json")
            .send(json!({ "version": version, "reply": reply }).to_string())
            .unwrap();
        assert_eq!(response.status().as_u16(), 409);
        assert_eq!(
            response_json(&mut response)["error"]["code"],
            "version_conflict"
        );
    }

    pub fn assert_import_requires_staff_preference(&self, request: &WaitlistRequest) {
        let mut payload = serde_json::to_value(request).unwrap();
        let preference = payload.as_object_mut().unwrap().remove("staffId");
        assert_eq!(preference, Some(Value::Null));
        let (name, value) = self.bearer_header();
        let mut response = self
            .agent
            .post(self.base.join("/api/admin/waitlist/desk").unwrap().as_str())
            .header(&name, &value)
            .content_type("application/json")
            .send(payload.to_string())
            .unwrap();
        assert_eq!(response.status().as_u16(), 400);
        assert_eq!(
            response_json(&mut response)["error"]["code"],
            "validation_error"
        );
    }

    pub fn public_reviews(&self) -> Value {
        let mut response = self
            .agent
            .get(self.base.join("/api/reviews").unwrap().as_str())
            .call()
            .unwrap();
        assert_eq!(response.status().as_u16(), 200);
        response_json(&mut response)
    }

    pub fn assert_inventory_patch_scope(&self, product_path: &str, version: u32) {
        let url = self.base.join(product_path).unwrap();
        assert_eq!(url.origin(), self.base.origin());
        let (name, value) = self.bearer_header();
        for (request, body, status) in [
            (
                self.agent.post(
                    self.base
                        .join("/admin/inventory/products")
                        .unwrap()
                        .as_str(),
                ),
                json!({
                    "name": "Out of scope", "priceCents": 500, "openingStock": 10, "idempotencyKey": "scope-bypass-fixture"
                }),
                403,
            ),
            (
                self.agent.patch(url.as_str()),
                json!({ "version": version, "name": "Out of scope" }),
                403,
            ),
            (
                self.agent.patch(&format!("{url}/package-content")),
                json!({
                    "version": version, "packageContent": null, "name": "Out of scope"
                }),
                400,
            ),
        ] {
            let response = request
                .header(&name, &value)
                .content_type("application/json")
                .send(body.to_string())
                .unwrap();
            assert_eq!(response.status().as_u16(), status);
        }
    }

    pub fn assert_inventory_ledger_is_read_only(&self) {
        let (name, value) = self.bearer_header();
        for path in [
            "/api/admin/inventory/movements",
            "/api/admin/inventory/movements/export",
        ] {
            let url = self.base.join(path).unwrap();
            let response = self
                .agent
                .post(url.as_str())
                .header(&name, &value)
                .content_type("application/json")
                .send("{}")
                .unwrap();
            assert_eq!(response.status().as_u16(), 403);
        }
    }

    pub fn disconnect_and_check(&self, protected_path: &str) {
        let (name, value) = self.bearer_header();
        let url = self.base.join(protected_path).unwrap();
        assert_eq!(url.origin(), self.base.origin());
        let status = || {
            self.agent
                .get(url.as_str())
                .header(&name, &value)
                .call()
                .unwrap()
                .status()
                .as_u16()
        };
        assert_eq!(status(), 200);
        let linked = self.session.read().unwrap().clone().unwrap();
        self.auth.disconnect_device(&linked).unwrap();
        assert_eq!(status(), 401);
    }
}
