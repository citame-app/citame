use super::{HttpTransport, TransportError, read_response};
use chrono::{DateTime, Utc};
use serde::Deserialize;

pub const LIVE_TOPIC: &str = "whatsapp_desk";

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
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

#[derive(Clone, Copy, Debug, Deserialize)]
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
    pub template_name: String,
    pub language: String,
    pub variables: Vec<Variable>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub phone: String,
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
pub struct WhatsAppDesk {
    pub configured: bool,
    pub connection: Option<Connection>,
    pub deliveries: Vec<Delivery>,
}

impl HttpTransport {
    pub fn whatsapp_desk(&self) -> Result<WhatsAppDesk, TransportError> {
        read_response(self.get(&self.agent, "/admin/whatsapp/desk", None)?, false)
    }
}
