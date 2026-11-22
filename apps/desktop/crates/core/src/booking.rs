//! Online booking with a reviewed appointment and intake kept outside the outbox.
use chrono::{DateTime, Datelike, Duration, SecondsFormat, Timelike, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
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
    #[serde(skip_serializing_if = "Option::is_none")]
    peak_price_review: Option<String>,
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

pub const MAX_PEAK_PRICE_RULES: usize = 100;
pub const MAX_PEAK_PRICE_SERVICES: usize = 200;
pub const MAX_PEAK_PRICE_BASIS_POINTS: u32 = 10_000;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeakPricePolicy {
    pub version: u32,
    pub generation: String,
    pub rules: Vec<PeakPriceRule>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeakPriceRule {
    pub weekday: u8,
    pub start_minute: u16,
    pub end_minute: u16,
    pub increase_basis_points: u32,
    pub service_ids: Vec<String>,
}

impl Default for PeakPriceRule {
    fn default() -> Self {
        Self {
            weekday: 1,
            start_minute: 540,
            end_minute: 600,
            increase_basis_points: 1000,
            service_ids: vec![],
        }
    }
}

impl PeakPriceRule {
    pub fn with_input(mut self, start: &str, end: &str, increase: &str) -> Option<Self> {
        self.start_minute = crate::promotions::parse_minute(start, false)?;
        self.end_minute = crate::promotions::parse_minute(end, true)?;
        self.increase_basis_points = crate::billing::parse_reviewed_amount(increase)?;
        (self.start_minute < self.end_minute
            && (1..=MAX_PEAK_PRICE_BASIS_POINTS).contains(&self.increase_basis_points))
        .then_some(self)
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeakPriceSnapshot {
    pub version: u32,
    pub timezone: String,
    pub rules: Vec<PeakPriceRule>,
}

impl PeakPriceSnapshot {
    pub(crate) fn validate(&self) -> Result<()> {
        if self.timezone.parse::<chrono_tz::Tz>().is_err()
            || self.rules.len() > MAX_PEAK_PRICE_RULES
            || self.rules.iter().any(|rule| {
                !(1..=7).contains(&rule.weekday)
                    || rule.start_minute >= rule.end_minute
                    || rule.end_minute > 1440
                    || !(1..=MAX_PEAK_PRICE_BASIS_POINTS).contains(&rule.increase_basis_points)
                    || rule.service_ids.len() > MAX_PEAK_PRICE_SERVICES
                    || rule
                        .service_ids
                        .iter()
                        .any(|id| uuid::Uuid::parse_str(id).is_err())
            })
        {
            return Err(CoreError::Protocol("Invalid peak price snapshot".into()));
        }
        Ok(())
    }

    pub fn quote<'a>(
        &self,
        start: DateTime<Utc>,
        services: impl IntoIterator<Item = &'a crate::model::Service>,
    ) -> Result<PeakPriceQuote> {
        use crate::model::CatalogPrice;
        let zone: chrono_tz::Tz = self
            .timezone
            .parse()
            .map_err(|_| CoreError::Protocol("Invalid peak price timezone".into()))?;
        let mut offset = 0;
        let mut canonical = Vec::new();
        let mut quotes = Vec::new();
        let mut lines = Vec::new();
        for service in services {
            let time = (start + Duration::minutes(offset)).with_timezone(&zone);
            offset += service.duration_minutes + service.buffer_minutes;
            let minute = time.hour() * 60 + time.minute();
            let increase = if matches!(
                service.price_type.unwrap_or_default(),
                CatalogPrice::Fixed | CatalogPrice::From
            ) {
                self.rules
                    .iter()
                    .filter(|rule| {
                        u32::from(rule.weekday) == time.weekday().number_from_monday()
                            && u32::from(rule.start_minute) <= minute
                            && minute < u32::from(rule.end_minute)
                            && (rule.service_ids.is_empty()
                                || rule.service_ids.contains(&service.id))
                    })
                    .map(|rule| i64::from(rule.increase_basis_points))
                    .max()
                    .unwrap_or(0)
            } else {
                0
            };
            let surcharge = (service.price_cents * increase + 5000) / 10_000;
            let price = service.price_cents + surcharge;
            if surcharge > 0 && price > 999_999_999 {
                return Err(CoreError::Invalid(
                    "Peak service price exceeds supported amount".into(),
                ));
            }
            canonical.push((
                &service.id,
                &service.currency,
                service.price_cents,
                surcharge,
                price,
            ));
            quotes.push(&service.quote_hash);
            lines.push(PeakPriceLine {
                service_id: service.id.clone(),
                surcharge_cents: surcharge,
                price_cents: price,
            });
        }
        // The API hashes the same JSON array of version, timezone, UTC instant, price tuples and
        // service-term hashes. Tuple order is part of the offline wire contract.
        let review = if lines.iter().any(|line| line.surcharge_cents > 0) {
            let encoded = serde_json::to_vec(&(
                self.version,
                &self.timezone,
                start.to_rfc3339_opts(SecondsFormat::Millis, true),
                canonical,
                quotes,
            ))?;
            const HEX: &[u8; 16] = b"0123456789abcdef";
            let token = Sha256::digest(encoded)
                .iter()
                .flat_map(|byte| {
                    [
                        char::from(HEX[usize::from(byte >> 4)]),
                        char::from(HEX[usize::from(byte & 15)]),
                    ]
                })
                .collect();
            Some(token)
        } else {
            None
        };
        Ok(PeakPriceQuote {
            review,
            services: lines,
        })
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeakPriceQuote {
    pub review: Option<String>,
    pub services: Vec<PeakPriceLine>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeakPriceLine {
    pub service_id: String,
    pub surcharge_cents: i64,
    pub price_cents: i64,
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
    pub price_cents: Option<i64>,
    pub peak_surcharge_cents: Option<i64>,
    pub peak_price_review: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewedSeries {
    #[serde(flatten)]
    packet: SeriesPacket,
    review_hash: String,
    idempotency_key: String,
    appointment_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    peak_price_reviews: Option<Vec<Option<String>>>,
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
    #[error("the reviewed peak-time price changed")]
    PeakPriceChanged,
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
            peak_price_review: None,
            forms: ReviewedForms {
                intake_review_hash: review_hash,
                intake_submission_ids: intake.saved,
                intake_responses: intake.inline,
            },
        }
    }
}

impl ReviewedBooking {
    pub fn with_peak_price_review(mut self, quote: Option<&PeakPriceQuote>) -> Self {
        self.peak_price_review = quote.and_then(|quote| quote.review.clone());
        self
    }

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
            peak_price_reviews: preview
                .occurrences
                .iter()
                .any(|date| date.peak_price_review.is_some())
                .then(|| {
                    preview
                        .occurrences
                        .iter()
                        .map(|date| date.peak_price_review.clone())
                        .collect()
                }),
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
