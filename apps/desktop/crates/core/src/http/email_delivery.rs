use super::{HttpTransport, TransportError, classify_status, read_response, read_response_with};
use serde::{Deserialize, Serialize};

const PATH: &str = "/admin/email-delivery";
pub const LIVE_TOPIC: &str = "email_delivery";

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

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    Inherit,
    Smtp,
    Gmail,
    Resend,
    Disabled,
}

impl Provider {
    pub fn current(settings: &EmailProvider) -> Self {
        match settings {
            EmailProvider::Inherit => Self::Inherit,
            EmailProvider::Smtp { .. } => Self::Smtp,
            EmailProvider::Gmail { .. } => Self::Gmail,
            EmailProvider::Resend { .. } => Self::Resend,
            EmailProvider::Disabled => Self::Disabled,
        }
    }

    pub fn active(self) -> bool {
        !matches!(self, Self::Disabled | Self::Inherit)
    }
}

pub struct EmailDraft<'a> {
    pub provider: Provider,
    pub encryption: Encryption,
    pub from_email: &'a str,
    pub from_name: &'a str,
    pub host: &'a str,
    pub port: &'a str,
    pub username: &'a str,
    pub credential: &'a str,
}

impl UpdateEmailDelivery {
    pub fn differs_from(&self, saved: &EmailDelivery) -> bool {
        self.settings != saved.settings || self.secret.is_some()
    }
}

impl EmailDraft<'_> {
    fn settings(&self) -> Option<EmailProvider> {
        let from_email = self.from_email.trim().to_owned();
        let from_name = self.from_name.trim().to_owned();
        if self.provider.active()
            && (from_email.is_empty()
                || from_email.encode_utf16().count() > 254
                || from_email.chars().any(char::is_whitespace)
                || !from_email.contains('@')
                || from_name.is_empty()
                || from_name.encode_utf16().count() > 100
                || from_name
                    .chars()
                    .any(|ch| ch.is_control() || matches!(ch, '<' | '>')))
        {
            return None;
        }
        Some(match self.provider {
            Provider::Inherit => EmailProvider::Inherit,
            Provider::Disabled => EmailProvider::Disabled,
            Provider::Smtp => {
                let port = self.port.trim().parse().ok().filter(|port| *port > 0)?;
                let host = self.host.trim().to_ascii_lowercase();
                let username = self.username.trim().to_owned();
                if host.is_empty()
                    || host.len() > 253
                    || username.is_empty()
                    || username.encode_utf16().count() > 254
                {
                    return None;
                }
                EmailProvider::Smtp {
                    from_email,
                    from_name,
                    host,
                    port,
                    encryption: self.encryption,
                    username,
                }
            }
            Provider::Gmail => EmailProvider::Gmail {
                from_email,
                from_name,
            },
            Provider::Resend => EmailProvider::Resend {
                from_email,
                from_name,
            },
        })
    }

    pub fn can_reuse_credential(&self, saved: &EmailDelivery) -> bool {
        if !saved.has_secret {
            return false;
        }
        match (&saved.settings, self.provider) {
            (
                EmailProvider::Smtp {
                    host,
                    port,
                    encryption,
                    username,
                    ..
                },
                Provider::Smtp,
            ) => {
                host.eq_ignore_ascii_case(self.host.trim())
                    && self.port.trim().parse() == Ok(*port)
                    && *encryption == self.encryption
                    && username == self.username.trim()
            }
            (EmailProvider::Gmail { from_email, .. }, Provider::Gmail) => {
                from_email == self.from_email.trim()
            }
            (EmailProvider::Resend { .. }, Provider::Resend) => true,
            _ => false,
        }
    }

    pub fn validated(&self, saved: &EmailDelivery) -> Option<UpdateEmailDelivery> {
        let settings = self.settings()?;
        let secret = if self.provider.active() {
            if self.credential.is_empty() {
                if !self.can_reuse_credential(saved) {
                    return None;
                }
                None
            } else {
                if self.credential.encode_utf16().count() > 1024
                    || self.credential.chars().any(char::is_control)
                {
                    return None;
                }
                Some(self.credential.to_owned())
            }
        } else {
            None
        };
        Some(UpdateEmailDelivery {
            settings,
            secret,
            revision: saved.revision.clone(),
        })
    }

    pub fn dirty(&self, saved: &EmailDelivery) -> bool {
        self.settings()
            .is_none_or(|settings| settings != saved.settings)
            || (self.provider.active() && !self.credential.is_empty())
    }
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
        let saved: EmailDelivery = read_response_with(response, delivery_error)?;
        if saved.revision.is_none() || saved.revision == change.revision {
            return Err(TransportError::Server("Invalid email settings revision".into()).into());
        }
        Ok(saved)
    }

    /// Sends a test to the account associated with this session.
    pub fn test_email_delivery(&self, revision: Option<String>) -> Result<(), SaveError> {
        #[derive(Deserialize)]
        struct Receipt {
            ok: bool,
        }
        #[derive(Serialize)]
        struct ReviewedTest {
            revision: Option<String>,
        }
        let response = self.send_json(
            "/admin/email-delivery/test-reviewed",
            &ReviewedTest { revision },
        )?;
        let receipt: Receipt = read_response_with(response, delivery_error)?;
        if !receipt.ok {
            return Err(TransportError::Server("Email test was not confirmed".into()).into());
        }
        Ok(())
    }
}

fn delivery_error(status: u16, retry_after: Option<&str>, body: &str) -> SaveError {
    if status == 409
        && serde_json::from_str::<serde_json::Value>(body).is_ok_and(|error| {
            error
                .pointer("/error/code")
                .and_then(serde_json::Value::as_str)
                == Some("version_conflict")
        })
    {
        SaveError::Conflict
    } else {
        classify_status(status, retry_after, body, false).into()
    }
}
