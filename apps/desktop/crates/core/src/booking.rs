//! Online booking with a reviewed appointment and intake kept outside the outbox.
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::error::{CoreError, Result};
use crate::intake::IntakeResponse;
use crate::intake::IntakeSelection;
use crate::model::AppointmentService;
use crate::ops::{NewAppointment, reviewed_service_terms, validate_contact};
use crate::store::Store;
use crate::sync::TransportError;
pub mod visit;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookingTerms {
    #[serde(rename = "desktopGeneration")]
    generation: String,
    id: String,
    #[serde(flatten)]
    fields: BookingFields,
    #[serde(skip_serializing)]
    reviewed_services: Vec<AppointmentService>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BookingFields {
    staff_id: String,
    service_ids: Vec<String>,
    service_quotes: BTreeMap<String, String>,
    starts_at: DateTime<Utc>,
    #[serde(flatten)]
    client: BookingClient,
    #[serde(skip_serializing_if = "Option::is_none")]
    notes: Option<String>,
    #[serde(rename = "override", skip_serializing_if = "Option::is_none")]
    override_notice: Option<bool>,
}

#[derive(Clone, Serialize)]
#[serde(untagged)]
enum BookingClient {
    Existing {
        #[serde(rename = "clientId")]
        id: String,
    },
    Inline {
        client: Contact,
    },
}

#[derive(Clone, Serialize)]
struct Contact {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    phone: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewedBooking {
    #[serde(flatten)]
    terms: BookingTerms,
    #[serde(flatten)]
    forms: ReviewedForms,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReviewedForms {
    intake_review_hash: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    intake_submission_ids: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    intake_responses: Vec<IntakeResponse>,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Cadence {
    Weekly,
    Monthly,
}

#[derive(Clone, Copy, Serialize)]
pub struct Recurrence {
    pub cadence: Cadence,
    pub interval: u8,
    pub count: u8,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesPacket {
    desktop_generation: String,
    #[serde(flatten)]
    fields: BookingFields,
    #[serde(flatten)]
    forms: ReviewedForms,
    #[serde(flatten)]
    recurrence: Recurrence,
    #[serde(skip_serializing_if = "Option::is_none")]
    protection_waiver_reason: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesPreview {
    pub review_hash: String,
    pub timezone: String,
    pub per_visit_cents: i64,
    pub currency: String,
    pub policy: SeriesBookingPolicy,
    pub occurrences: Vec<SeriesOccurrence>,
}

#[derive(Clone, Deserialize)]
pub struct SeriesBookingPolicy {
    pub enabled: bool,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesOccurrence {
    pub starts_at: DateTime<Utc>,
    pub ends_at: DateTime<Utc>,
    pub available: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewedSeries {
    #[serde(flatten)]
    packet: SeriesPacket,
    review_hash: String,
    idempotency_key: String,
    appointment_ids: Vec<String>,
    #[serde(skip_serializing)]
    reviewed_starts: Vec<DateTime<Utc>>,
}

#[derive(Clone)]
pub enum BookingAttempt {
    Single(ReviewedBooking),
    Series(ReviewedSeries),
}

#[derive(Debug, PartialEq, Eq)]
pub enum BookingConfirmation {
    Booked(DateTime<Utc>),
    SeriesChanged,
}

#[derive(Debug, thiserror::Error)]
pub enum BookingError {
    #[error("the booking requires a review of the current forms")]
    IntakeChanged,
    #[error("the booking slot is no longer available")]
    SlotUnavailable,
    #[error("the reviewed catalogue changed")]
    CatalogueChanged,
    #[error("access to the requested booking changed")]
    AccessChanged,
    #[error("this booking identity is associated with a different request")]
    IntentConflict,
    #[error("the booking was rejected")]
    Rejected,
    #[error(transparent)]
    Transport(#[from] TransportError),
}

impl BookingTerms {
    pub fn prepare(
        store: &Store,
        new: NewAppointment,
        inline: Option<(&str, Option<&str>)>,
    ) -> Result<Self> {
        let generation = store.verified_reviewed_generation()?;
        let client = match inline {
            Some((name, phone)) => {
                validate_contact(name, phone)?;
                BookingClient::Inline {
                    client: Contact {
                        name: name.to_owned(),
                        phone: phone.map(str::to_owned),
                    },
                }
            }
            None => {
                if store.has_pending_client_creation(&new.client_id)? {
                    return Err(CoreError::PendingClient);
                }
                BookingClient::Existing {
                    id: new.client_id.clone(),
                }
            }
        };
        let (service_quotes, reviewed_services) = reviewed_service_terms(store, &new)?;
        if store.verified_reviewed_generation()? != generation {
            return Err(CoreError::CalendarGenerationChanged);
        }
        Ok(Self {
            generation,
            id: uuid::Uuid::now_v7().to_string(),
            reviewed_services,
            fields: BookingFields {
                staff_id: new.staff_id,
                service_ids: new.service_ids,
                service_quotes,
                starts_at: new.starts_at,
                client,
                notes: new.notes,
                override_notice: new.override_notice.then_some(true),
            },
        })
    }

    pub fn service_ids(&self) -> &[String] {
        &self.fields.service_ids
    }

    pub fn staff_id(&self) -> &str {
        &self.fields.staff_id
    }
    pub fn client_id(&self) -> Option<&str> {
        match &self.fields.client {
            BookingClient::Existing { id } => Some(id),
            BookingClient::Inline { .. } => None,
        }
    }
    pub fn starts_at(&self) -> DateTime<Utc> {
        self.fields.starts_at
    }
    pub fn generation(&self) -> &str {
        &self.generation
    }
    pub fn services(&self) -> &[AppointmentService] {
        &self.reviewed_services
    }
    pub fn matches_service_quote(&self, id: &str, displayed_quote: &str) -> bool {
        self.fields
            .service_quotes
            .get(id)
            .is_some_and(|quote| quote == displayed_quote)
    }
    pub fn reviewed(&self, review_hash: String, intake: IntakeSelection) -> ReviewedBooking {
        ReviewedBooking {
            terms: self.clone(),
            forms: ReviewedForms {
                intake_review_hash: review_hash,
                intake_submission_ids: intake.saved,
                intake_responses: intake.inline,
            },
        }
    }
}

impl ReviewedBooking {
    /// Keep an opaque origin marker only. The booking and its responses stay in memory.
    pub fn mark_local_dispatch(&self, store: &mut Store) -> Result<()> {
        store.mark_local_booking_dispatch(&self.terms.id, &self.terms.generation)
    }

    pub(crate) fn matches(&self, id: &str, starts_at: DateTime<Utc>) -> bool {
        self.terms.id == id && self.terms.starts_at() == starts_at
    }

    pub fn series(&self, recurrence: Recurrence) -> SeriesPacket {
        SeriesPacket {
            desktop_generation: self.terms.generation.clone(),
            fields: self.terms.fields.clone(),
            forms: self.forms.clone(),
            recurrence,
            protection_waiver_reason: None,
        }
    }
}

impl SeriesPacket {
    pub fn with_deposit_waiver(mut self, reason: Option<String>) -> Self {
        self.protection_waiver_reason = reason;
        self
    }

    pub fn review(self, preview: &SeriesPreview) -> ReviewedSeries {
        let appointment_ids = (0..self.count())
            .map(|_| uuid::Uuid::now_v7().to_string())
            .collect();
        ReviewedSeries {
            packet: self,
            review_hash: preview.review_hash.clone(),
            idempotency_key: uuid::Uuid::now_v7().to_string(),
            appointment_ids,
            reviewed_starts: preview
                .occurrences
                .iter()
                .map(|visit| visit.starts_at)
                .collect(),
        }
    }

    pub(crate) fn count(&self) -> usize {
        self.recurrence.count.into()
    }
}

impl ReviewedSeries {
    pub(crate) fn confirm(
        &self,
        appointments: &[crate::waitlist::BookedAppointment],
    ) -> Result<BookingConfirmation, BookingError> {
        if appointments
            .iter()
            .any(|visit| !self.appointment_ids.contains(&visit.id))
        {
            return Err(TransportError::Server("Unexpected series acknowledgement".into()).into());
        }
        let unchanged = appointments.len() == self.appointment_ids.len()
            && appointments
                .iter()
                .zip(self.appointment_ids.iter().zip(&self.reviewed_starts))
                .all(|(visit, (id, starts_at))| visit.id == *id && visit.starts_at == *starts_at);
        if unchanged && let Some(first) = self.reviewed_starts.first() {
            return Ok(BookingConfirmation::Booked(*first));
        }
        Ok(BookingConfirmation::SeriesChanged)
    }
}

impl BookingAttempt {
    pub fn check_before_dispatch(&self, store: &mut Store) -> Result<()> {
        match self {
            Self::Single(booking) => booking.mark_local_dispatch(store),
            Self::Series(series) => store.mark_local_bookings_dispatch(
                series.appointment_ids.iter().map(String::as_str),
                &series.packet.desktop_generation,
            ),
        }
    }
}
