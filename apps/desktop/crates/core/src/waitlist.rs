use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WaitlistPage {
    pub page: u32,
    pub page_size: u32,
    pub total: u32,
    pub policy: WaitlistPolicy,
    pub entries: Vec<WaitlistEntry>,
    #[serde(default)]
    pub imported: Vec<ImportedRequest>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WaitlistPolicy {
    pub enabled: bool,
    pub offer_minutes: u32,
    pub version: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportedRequest {
    pub id: String,
    pub client_id: String,
    pub client_name: String,
    pub requested_date: NaiveDate,
    pub duration_minutes: u32,
    pub flexible: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum WaitlistState {
    Waiting,
    Offered,
    Booked,
    Cancelled,
    Expired,
    Unavailable,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WaitlistEntry {
    pub id: String,
    pub client_id: String,
    pub client_name: Option<String>,
    pub service_ids: Vec<String>,
    pub staff_id: Option<String>,
    pub service_names: Vec<String>,
    pub from_date: NaiveDate,
    pub to_date: NaiveDate,
    pub from_time: String,
    pub to_time: String,
    pub state: WaitlistState,
    pub version: u32,
    pub can_manage: bool,
    pub offer: Option<WaitlistOffer>,
    pub booked_appointment: Option<BookedAppointment>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WaitlistOffer {
    pub id: String,
    pub staff_id: String,
    pub staff_name: Option<String>,
    pub starts_at: DateTime<Utc>,
    pub ends_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub price_cents: u32,
    pub currency: String,
    pub services: Vec<OfferedService>,
    pub policy: OfferProtection,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OfferedService {
    pub name: String,
    pub price_cents: u32,
    pub currency: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct OfferProtection {
    pub enabled: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BookedAppointment {
    pub id: String,
    pub starts_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct AcceptedOffer {
    pub appointment: BookedAppointment,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AcceptOffer {
    pub version: u32,
    pub offer_id: String,
    pub expected_total_cents: u32,
    pub idempotency_key: String,
    pub intake_review_hash: String,
    pub intake_submission_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protection_waiver_reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfferRequirements {
    pub forms: Vec<RequiredForm>,
    pub review_hash: String,
    #[serde(default)]
    pub ready_responses: Vec<ReadyResponse>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct RequiredForm {
    pub id: String,
    pub definition: FormDefinition,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormDefinition {
    pub title: String,
    pub required_at_booking: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadyResponse {
    pub id: String,
    pub revision_id: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WaitlistRequest {
    pub client_id: String,
    pub staff_id: Option<String>,
    pub service_ids: Vec<String>,
    pub from_date: NaiveDate,
    pub to_date: NaiveDate,
    pub from_time: String,
    pub to_time: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub imported_entry_id: Option<String>,
    pub idempotency_key: String,
}

impl WaitlistRequest {
    pub fn new_key() -> String {
        uuid::Uuid::now_v7().to_string()
    }
}
