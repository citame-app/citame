use super::{HttpTransport, TransportError, classify_status, read_response, read_response_with};
use serde::{Deserialize, Serialize};

const PATH: &str = "/admin/email-delivery";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    tag = "provider",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum EmailProvider {
    Inherit,
    Disabled,
    Smtp {
        from_email: String,
        from_name: String,
        host: String,
        port: u16,
        encryption: Encryption,
        username: String,
    },
    Gmail {
        from_email: String,
        from_name: String,
    },
    Resend {
        from_email: String,
        from_name: String,
    },
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Encryption {
    Tls,
    #[default]
    StartTls,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailDelivery {
    pub revision: Option<String>,
    pub settings: EmailProvider,
    pub server_email_enabled: bool,
    pub has_secret: bool,
}

#[derive(Serialize)]
pub struct UpdateEmailDelivery {
    pub revision: Option<String>,
    pub settings: EmailProvider,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret: Option<String>,
}

#[derive(Debug)]
pub enum SaveError {
    Conflict,
    Transport(TransportError),
}

impl From<TransportError> for SaveError {
    fn from(error: TransportError) -> Self {
        Self::Transport(error)
    }
}

impl HttpTransport {
    pub fn email_delivery(&self) -> Result<EmailDelivery, TransportError> {
        read_response(self.get(&self.agent, PATH, None)?, false)
    }

    pub fn save_email_delivery(
        &self,
        change: &UpdateEmailDelivery,
    ) -> Result<EmailDelivery, SaveError> {
        let response = self.send_put_json(PATH, change)?;
        let saved: EmailDelivery = read_response_with(response, |status, retry_after, body| {
            if status == 409 {
                SaveError::Conflict
            } else {
                classify_status(status, retry_after, body, false).into()
            }
        })?;
        if saved.revision.is_none() || saved.revision == change.revision {
            return Err(TransportError::Server("Invalid email settings revision".into()).into());
        }
        Ok(saved)
    }

    /// Sends a test to the account associated with this session.
    pub fn test_email_delivery(&self) -> Result<(), TransportError> {
        #[derive(Deserialize)]
        struct Receipt {
            ok: bool,
        }
        let receipt: Receipt =
            self.post_json("/admin/email-delivery/test", &serde_json::json!({}))?;
        if !receipt.ok {
            return Err(TransportError::Server(
                "Email test was not confirmed".into(),
            ));
        }
        Ok(())
    }
}
