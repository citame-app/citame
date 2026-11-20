use super::*;
use ring::{
    rand::SystemRandom,
    signature::{Ed25519KeyPair, KeyPair},
};

#[derive(Clone, PartialEq, Eq, Deserialize, Serialize)]
pub(super) struct DeviceLink {
    id: uuid::Uuid,
    private_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Enrollment {
    device_id: uuid::Uuid,
}

#[derive(Deserialize)]
struct DeviceToken {
    access_token: String,
    expires_in: i64,
}

fn device_label() -> String {
    let platform = match std::env::consts::OS {
        "macos" => "Mac",
        "linux" => "Linux",
        os => os,
    };
    let host = std::env::var("HOSTNAME")
        .ok()
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok());
    let host: String = host
        .as_deref()
        .unwrap_or_default()
        .trim()
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '.' | '_')
        })
        .take(45)
        .collect();
    if host.is_empty() {
        format!("Citame Desktop · {platform}")
    } else {
        format!("{host} · {platform}")
    }
}

impl BetterAuthSession {
    pub(super) fn link_device(
        &self,
        bootstrap: &OAuthCredentials,
    ) -> Result<OAuthCredentials, AuthError> {
        let bytes = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
            .map_err(|_| AuthError::Unexpected("Could not generate the device key".into()))?;
        let key = Ed25519KeyPair::from_pkcs8(bytes.as_ref())
            .map_err(|_| AuthError::Unexpected("Invalid device key".into()))?;
        let mut response = self
            .agent
            .post(&format!("{}/api/auth/desktop/link", self.base_url))
            .header(
                "Authorization",
                &format!("Bearer {}", bootstrap.access_token),
            )
            .content_type("application/json")
            .send(
                serde_json::json!({
                    "publicKey": URL_SAFE_NO_PAD.encode(key.public_key().as_ref()),
                    "label": device_label(),
                })
                .to_string(),
            )
            .map_err(|e| AuthError::Network(e.to_string()))?;
        match response.status().as_u16() {
            200 => {
                let enrollment: Enrollment = read_response(&mut response)?;
                Ok(OAuthCredentials {
                    access_token: String::new(),
                    refresh_token: String::new(),
                    expires_at: 0,
                    device: Some(DeviceLink {
                        id: enrollment.device_id,
                        private_key: URL_SAFE_NO_PAD.encode(bytes.as_ref()),
                    }),
                })
            }
            401 => Err(AuthError::InvalidCredentials),
            403 => Err(AuthError::WrongRole("client".into())),
            status => Err(AuthError::Network(format!(
                "Could not link the device (HTTP {status})"
            ))),
        }
    }

    fn device_proof(
        &self,
        device: &DeviceLink,
        action: &str,
    ) -> Result<ureq::http::Response<ureq::Body>, AuthError> {
        self.send_device_proof(device, action, &[], serde_json::json!({}))
    }

    pub(super) fn send_device_proof(
        &self,
        device: &DeviceLink,
        action: &str,
        binding: &[&str],
        mut body: serde_json::Value,
    ) -> Result<ureq::http::Response<ureq::Body>, AuthError> {
        let key = URL_SAFE_NO_PAD
            .decode(&device.private_key)
            .ok()
            .and_then(|bytes| Ed25519KeyPair::from_pkcs8(&bytes).ok())
            .ok_or_else(|| AuthError::Storage("Invalid device key".into()))?;
        let nonce = crate::pkce::new_verifier();
        let id = device.id;
        let resource = format!("{}/api/auth/desktop", self.base_url);
        let issued_at = chrono::Utc::now().timestamp();
        let mut message =
            format!("citame-desktop-v1\n{resource}\n{id}\n{action}\n{issued_at}\n{nonce}");
        for field in binding {
            message.push('\n');
            message.push_str(field);
        }
        let signature = URL_SAFE_NO_PAD.encode(key.sign(message.as_bytes()).as_ref());
        let proof = serde_json::json!({
            "deviceId": id, "issuedAt": issued_at, "nonce": nonce, "signature": signature,
        });
        if action == "browser-ticket" {
            body["proof"] = proof;
        } else {
            body = proof;
        }
        self.agent
            .post(&format!("{resource}/{action}"))
            .content_type("application/json")
            .send(body.to_string())
            .map_err(|e| AuthError::Network(e.to_string()))
    }

    pub(super) fn renew_device(&self, device: &DeviceLink) -> Result<(String, i64), AuthError> {
        let mut response = self.device_proof(device, "token")?;
        match response.status().as_u16() {
            200 => {
                let token: DeviceToken = read_response(&mut response)?;
                if !token.access_token.starts_with("cd1.") || token.expires_in <= 0 {
                    return Err(AuthError::Unexpected(
                        "Invalid device token response".into(),
                    ));
                }
                Ok((
                    token.access_token,
                    chrono::Utc::now()
                        .timestamp()
                        .saturating_add(token.expires_in),
                ))
            }
            403 | 404 => Err(AuthError::InvalidCredentials),
            status => Err(AuthError::Network(format!(
                "Could not renew device credentials (HTTP {status})"
            ))),
        }
    }

    pub fn disconnect_device(&self, session: &Session) -> Result<(), AuthError> {
        let Some(device) = session
            .oauth
            .as_ref()
            .and_then(|credentials| credentials.device.as_ref())
        else {
            return Ok(());
        };
        self.revoke_device(device)
    }

    pub(super) fn revoke_device(&self, device: &DeviceLink) -> Result<(), AuthError> {
        match self.device_proof(device, "revoke")?.status().as_u16() {
            204 | 404 => Ok(()),
            status => Err(AuthError::Network(format!(
                "Could not disconnect the device (HTTP {status})"
            ))),
        }
    }
}
