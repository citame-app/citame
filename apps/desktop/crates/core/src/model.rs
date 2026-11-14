//! Wire and read-model types. They mirror `packages/contracts/src/sync.ts` and `appointments.ts`
//! (the Rust client implements the same shapes by hand, see docs/sync-protocol.md).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AppointmentStatus {
    Booked,
    Completed,
    Cancelled,
    NoShow,
}

impl AppointmentStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Booked => "booked",
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
            Self::NoShow => "no_show",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "booked" => Some(Self::Booked),
            "completed" => Some(Self::Completed),
            "cancelled" => Some(Self::Cancelled),
            "no_show" => Some(Self::NoShow),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppointmentService {
    pub service_id: Option<String>,
    pub name: String,
    pub duration_minutes: i64,
    pub buffer_minutes: i64,
    pub price_cents: i64,
    pub currency: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Appointment {
    pub id: String,
    pub staff_id: String,
    pub client_id: String,
    pub starts_at: DateTime<Utc>,
    pub ends_at: DateTime<Utc>,
    pub status: AppointmentStatus,
    pub notes: Option<String>,
    pub version: i64,
    pub services: Vec<AppointmentService>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Client {
    pub id: String,
    pub name: String,
    pub phone: Option<String>,
    pub email: Option<String>,
    pub notes: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Service {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub duration_minutes: i64,
    pub buffer_minutes: i64,
    pub price_cents: i64,
    pub currency: String,
    pub active: bool,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Staff {
    pub id: String,
    pub display_name: String,
    pub active: bool,
    pub user_id: Option<String>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStaff {
    pub id: String,
    pub service_id: String,
    pub staff_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingHours {
    pub id: String,
    pub staff_id: String,
    /// 0 = Sunday ... 6 = Saturday.
    pub weekday: i64,
    pub start_time: String,
    pub end_time: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeOff {
    pub id: String,
    pub staff_id: String,
    pub starts_at: DateTime<Utc>,
    pub ends_at: DateTime<Utc>,
    pub reason: Option<String>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SalonSettings {
    pub name: String,
    pub timezone: String,
    pub slot_granularity_minutes: i64,
    pub min_notice_minutes: i64,
    pub max_days_ahead: i64,
    pub updated_at: DateTime<Utc>,
}

/// One entry of the server change log, as received. `data` stays untyped until it is applied so
/// that an unknown future entity is reported precisely instead of failing the whole page.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct RawChange {
    pub seq: i64,
    pub entity: String,
    pub id: String,
    pub op: String,
    pub data: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullResponse {
    pub changes: Vec<RawChange>,
    pub next_cursor: i64,
    pub has_more: bool,
    pub head_seq: i64,
}

/// A mutation exactly as sent in `POST /sync/push`.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireMutation {
    pub mutation_id: String,
    pub created_at: String,
    pub kind: String,
    pub payload: Value,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushRequest {
    pub device_id: String,
    pub mutations: Vec<WireMutation>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum MutationResult {
    #[serde(rename_all = "camelCase")]
    Applied {
        mutation_id: String,
        applied_seq: Option<i64>,
        #[serde(default)]
        replayed: bool,
    },
    #[serde(rename_all = "camelCase")]
    Rejected {
        mutation_id: String,
        reason: String,
        message: String,
        #[serde(default)]
        replayed: bool,
    },
    #[serde(rename_all = "camelCase")]
    Retry { mutation_id: String, message: String },
}

impl MutationResult {
    pub fn mutation_id(&self) -> &str {
        match self {
            Self::Applied { mutation_id, .. }
            | Self::Rejected { mutation_id, .. }
            | Self::Retry { mutation_id, .. } => mutation_id,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushResponse {
    pub results: Vec<MutationResult>,
    pub head_seq: i64,
}

/// A queued local mutation, as stored in the outbox.
#[derive(Debug, Clone, PartialEq)]
pub struct OutboxEntry {
    pub seq: i64,
    pub mutation_id: String,
    pub created_at: String,
    pub kind: String,
    pub entity_id: String,
    pub payload: Value,
    pub attempts: i64,
    pub last_error: Option<String>,
}

impl OutboxEntry {
    pub fn to_wire(&self) -> WireMutation {
        WireMutation {
            mutation_id: self.mutation_id.clone(),
            created_at: self.created_at.clone(),
            kind: self.kind.clone(),
            payload: self.payload.clone(),
        }
    }
}

/// A rejected mutation the user has to look at (never discarded silently).
#[derive(Debug, Clone, PartialEq)]
pub struct Conflict {
    pub mutation_id: String,
    pub kind: String,
    pub entity_id: String,
    pub payload: Value,
    pub reason: String,
    pub message: String,
    pub created_at: String,
}

impl Conflict {
    /// Only appointment mutations have a resolution flow (reschedule or cancel).
    pub fn is_appointment(&self) -> bool {
        self.kind.starts_with("appointment.")
    }
}
