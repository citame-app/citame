use super::{HttpTransport, TransportError, read_response};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

pub const LIVE_TOPIC: &str = "whatsapp_desk";

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Event {
    Confirmation,
    #[serde(rename = "reminder_24h")]
    Reminder24h,
    #[serde(rename = "reminder_2h")]
    Reminder2h,
    Rescheduled,
    Cancellation,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Variable {
    Client,
    Salon,
    Date,
    Time,
    Staff,
    Services,
    Preferences,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Pending,
    Processing,
    Sent,
    Skipped,
    Cancelled,
    Failed,
    Delivered,
    Read,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    pub kind: Event,
    pub template_id: String,
    pub template_name: String,
    pub language: String,
    pub variables: Vec<Variable>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub phone: String,
    pub revision: String,
    pub coexistence: bool,
    pub expires_at: Option<DateTime<Utc>>,
    pub rules: Vec<Rule>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Delivery {
    pub kind: Event,
    pub scheduled_for: DateTime<Utc>,
    pub status: Status,
    pub delivery: Option<Status>,
    pub uncertain: bool,
}

impl Delivery {
    pub fn displayed_status(&self) -> Option<Status> {
        if self.uncertain && self.delivery.is_none() {
            None
        } else {
            self.delivery.or(Some(self.status))
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct ApprovedTemplate {
    pub id: String,
    pub name: String,
    pub language: String,
    pub parameters: Vec<String>,
    pub body: String,
}

impl ApprovedTemplate {
    pub fn sample(&self, values: &[Option<&str>]) -> String {
        let mut preview = String::with_capacity(self.body.len());
        for chunk in self.body.split_inclusive("}}") {
            let replace = chunk.strip_suffix("}}").and_then(|closed| {
                let (prefix, name) = closed.rsplit_once("{{")?;
                let index = self
                    .parameters
                    .iter()
                    .position(|parameter| parameter == name.trim())?;
                Some((prefix, values.get(index).copied().flatten()?))
            });
            if let Some((prefix, sample)) = replace {
                preview.push_str(prefix);
                preview.push_str(sample);
            } else {
                preview.push_str(chunk);
            }
        }
        preview
    }
}

pub const EVENTS: [Event; 5] = [
    Event::Confirmation,
    Event::Reminder24h,
    Event::Reminder2h,
    Event::Rescheduled,
    Event::Cancellation,
];
pub const VARIABLES: [Variable; 7] = [
    Variable::Client,
    Variable::Salon,
    Variable::Date,
    Variable::Time,
    Variable::Staff,
    Variable::Services,
    Variable::Preferences,
];

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleChange {
    pub kind: Event,
    pub template_id: String,
    pub variables: Vec<Variable>,
}

#[derive(Debug, Serialize)]
pub struct RulesChange {
    pub revision: String,
    pub rules: Vec<RuleChange>,
}

impl Connection {
    pub fn editable_rules(&self) -> Vec<RuleChange> {
        EVENTS
            .iter()
            .filter_map(|kind| {
                self.rules
                    .iter()
                    .find(|rule| rule.kind == *kind)
                    .map(|rule| RuleChange {
                        kind: rule.kind,
                        template_id: rule.template_id.clone(),
                        variables: rule.variables.clone(),
                    })
            })
            .collect()
    }
}

#[derive(Debug, Deserialize)]
pub struct WhatsAppDesk {
    pub configured: bool,
    pub connection: Option<Connection>,
    pub deliveries: Vec<Delivery>,
}

#[derive(Default)]
pub struct DeskRefresh {
    observed: Option<i64>,
    retry_at: Option<Instant>,
}

impl DeskRefresh {
    pub fn ready(&self, cursor: Option<i64>, requested: bool, now: Instant) -> bool {
        self.retry_at
            .map_or(requested || cursor != self.observed, |retry| now >= retry)
    }

    pub fn applied(&mut self, cursor: Option<i64>) {
        self.observed = cursor;
        self.retry_at = None;
    }

    /// Keep the prior snapshot only for transient transport failures.
    pub fn failed(&mut self, cursor: Option<i64>, error: &TransportError, now: Instant) -> bool {
        let fallback = Duration::from_secs(3);
        let delay = match error {
            TransportError::Offline(_) | TransportError::Server(_) => fallback,
            TransportError::RateLimited(delay) => delay.unwrap_or(fallback),
            _ => {
                self.applied(cursor);
                return false;
            }
        };
        self.retry_at = now.checked_add(delay);
        true
    }
}

impl HttpTransport {
    pub fn whatsapp_desk(&self) -> Result<WhatsAppDesk, TransportError> {
        read_response(self.get(&self.agent, "/admin/whatsapp/desk", None)?, false)
    }

    pub fn whatsapp_templates(&self) -> Result<Vec<ApprovedTemplate>, TransportError> {
        let response = self.get(&self.agent, "/admin/whatsapp/templates", None)?;
        read_response(response, false)
    }

    /// A conflict leaves the reviewed rules untouched on the server.
    pub fn save_whatsapp_rules(&self, input: &RulesChange) -> Result<bool, TransportError> {
        let mut request = self
            .agent
            .patch(&format!("{}/admin/whatsapp/rules/reviewed", self.base_url));
        for (name, value) in self.headers()? {
            request = request.header(name, value);
        }
        let body = serde_json::to_string(input)
            .map_err(|_| TransportError::BadRequest("Invalid reviewed WhatsApp rules".into()))?;
        let response = request
            .content_type("application/json")
            .send(body)
            .map_err(|error| TransportError::Offline(error.to_string()))?;
        use super::{classify_status, read_response_with};
        let result = read_response_with::<serde::de::IgnoredAny, Option<TransportError>>(
            response,
            |status, retry_after, body| {
                if status == 409
                    && serde_json::from_str::<serde_json::Value>(body).is_ok_and(|error| {
                        error
                            .pointer("/error/code")
                            .and_then(serde_json::Value::as_str)
                            == Some("version_conflict")
                    })
                {
                    None
                } else {
                    Some(classify_status(status, retry_after, body, false))
                }
            },
        );
        match result {
            Ok(_) => Ok(true),
            Err(None) => Ok(false),
            Err(Some(error)) => Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_refresh_triggers_wait_for_retry_after_and_then_reconcile() {
        let now = Instant::now();
        let mut refresh = DeskRefresh::default();
        refresh.applied(Some(7));
        assert!(!refresh.ready(Some(7), false, now));
        assert!(refresh.ready(Some(8), false, now));
        let retry = Duration::from_secs(30);
        assert!(refresh.failed(Some(8), &TransportError::RateLimited(Some(retry)), now));
        assert!(!refresh.ready(Some(9), true, now));
        assert!(!refresh.ready(Some(9), false, now + Duration::from_secs(29)));
        assert!(refresh.ready(Some(9), false, now + retry));
        refresh.applied(Some(9));
        assert!(!refresh.ready(Some(9), false, now + retry));
        assert!(refresh.ready(Some(9), true, now + retry));
        assert!(!refresh.failed(Some(9), &TransportError::Unauthorized, now));
    }
}
