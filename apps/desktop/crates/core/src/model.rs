//! Wire and read-model types. They mirror `packages/contracts/src/sync.ts` and `appointments.ts`
//! (the Rust client implements the same shapes by hand, see docs/sync-protocol.md).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CalendarNoticeKind {
    New,
    Rescheduled,
    Cancelled,
}

impl CalendarNoticeKind {
    pub fn appointment_status(self) -> AppointmentStatus {
        match self {
            Self::New | Self::Rescheduled => AppointmentStatus::Booked,
            Self::Cancelled => AppointmentStatus::Cancelled,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarNotice {
    pub id: String,
    pub kind: CalendarNoticeKind,
    pub created_at: DateTime<Utc>,
    pub appointment_id: String,
    pub staff_id: String,
    pub starts_at: DateTime<Utc>,
    pub appointment_starts_at: DateTime<Utc>,
    pub client_name: String,
    pub service_names: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarInbox {
    pub entries: Vec<CalendarNotice>,
    pub page: u32,
    pub page_size: u32,
    pub total: u32,
}
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
pub struct ProcessingTime {
    pub starts_after_minutes: i64,
    pub minutes: i64,
}

fn one() -> i64 {
    1
}
fn is_one(value: &i64) -> bool {
    *value == 1
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppointmentService {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub processing: Option<ProcessingTime>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub source_unpriced: bool,
    pub service_id: Option<String>,
    pub name: String,
    pub duration_minutes: i64,
    pub buffer_minutes: i64,
    pub price_cents: i64,
    pub currency: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkWindow {
    pub offset_minutes: i64,
    pub end_offset_minutes: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BillingReviewReason {
    UnknownAmount,
    PaidInBooksy,
    InvoicedInBooksy,
    UnknownBooksyPayment,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalBalance {
    pub paid_in_booksy_cents: u32,
    pub due_in_citame_cents: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CalendarBillingSource {
    Citame,
    Booksy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarServiceBadge {
    pub service_position: usize,
    pub requested: bool,
    pub invoiced: bool,
    pub paid: bool,
    pub billing_source: Option<CalendarBillingSource>,
    pub internal_note: bool,
    pub customer_comment: bool,
}

/// Read directly from the authorized appointment endpoint, separate from the offline replica.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppointmentAnnotations {
    pub appointment_version: Option<i64>,
    pub can_edit: Option<bool>,
    pub default_requested: Option<bool>,
    pub rows: Vec<ServiceAnnotations>,
    pub customer_comment: Option<String>,
    pub business_message: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceAnnotations {
    pub service_position: usize,
    pub version: u32,
    pub requested_staff_id: Option<String>,
    pub internal_note: Option<String>,
    pub customer_comment: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateServiceAnnotations {
    pub appointment_version: i64,
    pub service_position: usize,
    pub version: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested: Option<bool>,
    pub internal_note: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookedResource {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_id: Option<String>,
    pub name: String,
    pub quantity: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Appointment {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visit_group_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub itinerary_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub combination_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub combination_staff_ids: Option<Vec<String>>,
    pub staff_id: String,
    pub client_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_name: Option<String>,
    pub starts_at: DateTime<Utc>,
    pub ends_at: DateTime<Utc>,
    pub status: AppointmentStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_windows: Option<Vec<WorkWindow>>,
    pub notes: Option<String>,
    pub version: i64,
    pub services: Vec<AppointmentService>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub resources: Vec<BookedResource>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub service_badges: Vec<CalendarServiceBadge>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub billing_review_reasons: Vec<BillingReviewReason>,
    #[serde(default)]
    pub externally_settled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external_balance: Option<ExternalBalance>,
    #[serde(default)]
    pub imported_from_booksy: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub booksy_unpaid_confirmed: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl Appointment {
    pub fn billing_review_reasons(&self) -> impl Iterator<Item = BillingReviewReason> + '_ {
        self.billing_review_reasons.iter().copied().map(|reason| {
            // An older client may already have synced the compatibility hold before upgrade.
            if reason == BillingReviewReason::UnknownAmount
                && self.imported_from_booksy
                && self.services.iter().all(|line| !line.source_unpriced)
            {
                BillingReviewReason::UnknownBooksyPayment
            } else {
                reason
            }
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Client {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merged_into_id: Option<String>,
    pub name: String,
    pub phone: Option<String>,
    pub email: Option<String>,
    #[serde(default)]
    pub email_editable: bool,
    pub notes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub controls_version: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_names: Option<Vec<String>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl Client {
    /// Tags and booking access have a separate revision from the contact fields.
    pub(crate) fn same_contact(&self, reviewed: &Self) -> bool {
        self.id == reviewed.id
            && self.merged_into_id == reviewed.merged_into_id
            && self.name == reviewed.name
            && self.phone == reviewed.phone
            && self.email == reviewed.email
            && self.email_editable == reviewed.email_editable
            && self.notes == reviewed.notes
            && self.created_at == reviewed.created_at
            && self.updated_at == reviewed.updated_at
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CatalogPrice {
    #[default]
    Fixed,
    From,
    Variable,
    Hidden,
    Free,
}

impl CatalogPrice {
    pub const ALL: [Self; 5] = [
        Self::Fixed,
        Self::From,
        Self::Variable,
        Self::Hidden,
        Self::Free,
    ];

    pub fn requires_amount(self) -> bool {
        !matches!(self, Self::Variable | Self::Free)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Service {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sort_order: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub online_booking: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub booking_interval_minutes: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_instructions: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub price_type: Option<CatalogPrice>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalog: Option<ServiceOption>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub processing: Option<ProcessingTime>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quote_hash: Option<String>,
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    pub description: Option<String>,
    pub duration_minutes: i64,
    pub buffer_minutes: i64,
    pub price_cents: i64,
    pub currency: String,
    pub active: bool,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ServiceOption {
    Variant {
        parent_service_id: String,
        option_label: String,
    },
    Addon {
        allowed_service_ids: std::collections::BTreeSet<String>,
    },
}

impl Service {
    pub fn is_addon_target(&self, currency: &str) -> bool {
        self.active
            && self.currency == currency
            && !matches!(self.catalog, Some(ServiceOption::Addon { .. }))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Staff {
    #[serde(default = "one", skip_serializing_if = "is_one")]
    pub max_concurrent: i64,
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
pub struct DateShiftRange {
    pub start_time: String,
    pub end_time: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DateShift {
    pub id: String,
    pub staff_id: String,
    pub date: String,
    /// None inherits the weekly template; Some([]) is explicitly closed.
    pub ranges: Option<Vec<DateShiftRange>>,
    pub version: i64,
    pub updated_at: DateTime<Utc>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generation: Option<String>,
    pub changes: Vec<RawChange>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub refresh: Vec<String>,
    pub next_cursor: i64,
    pub has_more: bool,
    pub head_seq: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_off_scope: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_directory: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gift_cards_scope: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_groups: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub booked_resource_ids: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calendar_scope: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub viewer_role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub viewer_edit_catalogue: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_pools: Option<Vec<crate::resource_pools::ManagedPool>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub combinations: Option<Vec<crate::combinations::ManagedCombination>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub booking_combinations: Option<Vec<crate::combinations::ManagedCombination>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub booking_combination_access: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub peak_prices: Option<crate::booking::PeakPriceSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub peak_price_access: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub viewer_write_inventory: Option<bool>,
    pub portfolio_uploads: Option<bool>,
    #[serde(default)]
    pub viewer_read_inventory: Option<bool>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generation: Option<String>,
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
    Retry {
        mutation_id: String,
        message: String,
    },
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

#[derive(Debug, PartialEq, Eq)]
pub enum AppointmentEditSync {
    Pending,
    NeedsResolution,
    Settled,
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
        let mut payload = self.payload.clone();
        if self.kind == "appointment.create"
            && let Some(fields) = payload.as_object_mut()
        {
            fields.remove("_reviewedServices");
            fields.remove("_clientName");
            fields.remove("_combinationStaffIds");
        } else if self.kind == crate::store::SERVICE_EDIT_KIND
            && let Some(fields) = payload.as_object_mut()
        {
            fields.remove("_reviewed");
            fields.remove("_reviewedCatalog");
        } else if self.kind == crate::service_resources::MUTATION_KIND
            && let Some(fields) = payload.as_object_mut()
        {
            fields.remove("_reviewed");
        } else if matches!(
            self.kind.as_str(),
            crate::resource_pools::CREATE | crate::resource_pools::UPDATE
        ) && let Some(fields) = payload.as_object_mut()
        {
            fields.remove("_reviewed");
            if self.kind == crate::resource_pools::CREATE {
                fields.remove("active");
            }
        } else if matches!(
            self.kind.as_str(),
            crate::combinations::CREATE | crate::combinations::UPDATE
        ) && let Some(fields) = payload.as_object_mut()
        {
            if let Some(reviewed) = fields.remove("_reviewed") {
                if reviewed.get("fixedTerms").is_some() && !fields.contains_key("fixedTerms") {
                    fields.insert("fixedTerms".into(), Value::Null);
                } else if fields.get("active").and_then(Value::as_bool) == Some(false)
                    && fields.get("serviceIds") == reviewed.get("serviceIds")
                    && fields.get("fixedTerms") == reviewed.get("fixedTerms")
                {
                    fields.remove("fixedTerms");
                }
            }
        } else if matches!(
            self.kind.as_str(),
            crate::product_editor::CREATE | crate::product_editor::UPDATE
        ) && let Some(fields) = payload.as_object_mut()
        {
            fields.remove("_draft");
            fields.remove("_reviewed");
        } else if self.kind == crate::inventory_classifications::SAVE
            && let Some(fields) = payload.as_object_mut()
        {
            fields.remove("_reviewed");
        }
        WireMutation {
            mutation_id: self.mutation_id.clone(),
            created_at: self.created_at.clone(),
            kind: self.kind.clone(),
            payload,
        }
    }
}

pub(crate) const RESTORED_HISTORY: &str = "sync_generation_changed";

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
    pub fn requires_restored_review(&self) -> bool {
        self.reason == RESTORED_HISTORY
    }

    /// Only appointment mutations have a resolution flow (reschedule or cancel).
    pub fn is_appointment(&self) -> bool {
        self.kind.starts_with("appointment.")
    }
}
