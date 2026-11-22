//! A reviewed multi-professional visit, kept in memory until the whole itinerary commits.

use super::{BookingError, BookingTerms, ReviewedForms};
use crate::error::{CoreError, Result};
use crate::intake::IntakeSelection;
use crate::ops::NewAppointment;
use crate::store::Store;
use crate::sync::TransportError;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

pub struct VisitSelection {
    pub client_id: String,
    pub starts_at: DateTime<Utc>,
    pub notes: Option<String>,
    pub parts: Vec<VisitPartSelection>,
}

#[derive(Clone)]
pub struct VisitPartSelection {
    pub staff_id: String,
    pub service_ids: Vec<String>,
}

pub struct VisitTerms {
    selection: VisitSelection,
    generation: String,
    id: String,
    terms: Vec<BookingTerms>,
}

pub struct VisitPartReview {
    pub intake_hash: String,
    pub intake: IntakeSelection,
    pub protection_waiver_reason: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VisitPacket {
    id: String,
    client_id: String,
    starts_at: DateTime<Utc>,
    desktop_generation: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    notes: Option<String>,
    parts: Vec<VisitPartPacket>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VisitPartPacket {
    id: String,
    staff_id: String,
    service_ids: Vec<String>,
    service_quotes: BTreeMap<String, String>,
    #[serde(flatten)]
    forms: ReviewedForms,
    #[serde(skip_serializing_if = "Option::is_none")]
    protection_waiver_reason: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisitPreview {
    pub review_hash: String,
    pub timezone: String,
    pub currency: String,
    pub deposit_enabled: bool,
    pub parts: Vec<VisitPreviewPart>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisitPreviewPart {
    pub id: String,
    pub starts_at: DateTime<Utc>,
    pub ends_at: DateTime<Utc>,
    pub price_cents: i64,
    pub peak_surcharge_cents: Option<i64>,
    pub peak_price_review: Option<String>,
    pub price_status: VisitPriceStatus,
    pub deposit_waiver_required: bool,
    pub available: bool,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VisitPriceStatus {
    Fixed,
    From,
    Pending,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewedVisit {
    #[serde(flatten)]
    packet: VisitPacket,
    review_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    peak_price_reviews: Option<Vec<Option<String>>>,
    #[serde(skip_serializing)]
    expected_starts: Vec<DateTime<Utc>>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum VisitConfirmation {
    Booked(DateTime<Utc>),
    Changed,
}

impl VisitTerms {
    pub fn prepare(store: &Store, selection: VisitSelection) -> Result<Self> {
        let ids: Vec<_> = selection
            .parts
            .iter()
            .flat_map(|part| &part.service_ids)
            .collect();
        if !(2..=8).contains(&selection.parts.len())
            || ids.len() > 24
            || ids.iter().copied().collect::<HashSet<_>>().len() != ids.len()
        {
            return Err(CoreError::IncompatibleServices);
        }
        let generation = store.verified_reviewed_generation()?;
        let terms = selection
            .parts
            .iter()
            .map(|part| {
                BookingTerms::prepare(
                    store,
                    NewAppointment {
                        staff_id: part.staff_id.clone(),
                        service_ids: part.service_ids.clone(),
                        starts_at: selection.starts_at,
                        client_id: selection.client_id.clone(),
                        notes: None,
                        override_notice: false,
                    },
                    None,
                )
            })
            .collect::<Result<Vec<_>>>()?;
        if store.verified_reviewed_generation()? != generation {
            return Err(CoreError::CalendarGenerationChanged);
        }
        Ok(Self {
            selection,
            generation,
            id: uuid::Uuid::now_v7().to_string(),
            terms,
        })
    }

    pub fn parts(&self) -> &[BookingTerms] {
        &self.terms
    }

    pub fn packet(&self, reviews: Vec<VisitPartReview>) -> Result<VisitPacket> {
        if reviews.len() != self.terms.len() {
            return Err(CoreError::Invalid("Review every visit step".into()));
        }
        let parts = self
            .terms
            .iter()
            .zip(reviews)
            .map(|(part, review)| VisitPartPacket {
                id: part.id.clone(),
                staff_id: part.fields.staff_id.clone(),
                service_ids: part.fields.service_ids.clone(),
                service_quotes: part.fields.service_quotes.clone(),
                forms: part.reviewed(review.intake_hash, review.intake).forms,
                protection_waiver_reason: review.protection_waiver_reason,
            })
            .collect();
        Ok(VisitPacket {
            id: self.id.clone(),
            client_id: self.selection.client_id.clone(),
            starts_at: self.selection.starts_at,
            desktop_generation: self.generation.clone(),
            notes: self.selection.notes.clone(),
            parts,
        })
    }
}

impl VisitPacket {
    pub(crate) fn matches_preview(&self, preview: &VisitPreview) -> bool {
        preview.parts.len() == self.parts.len()
            && preview.timezone.parse::<chrono_tz::Tz>().is_ok()
            && preview
                .parts
                .first()
                .is_some_and(|part| part.starts_at == self.starts_at)
            && preview
                .parts
                .windows(2)
                .all(|pair| pair[0].ends_at == pair[1].starts_at)
            && preview
                .parts
                .iter()
                .zip(&self.parts)
                .all(|(review, input)| {
                    review.id == input.id
                        && review.starts_at < review.ends_at
                        && review.price_cents >= 0
                })
    }

    pub fn confirmable(self, preview: &VisitPreview) -> Result<ReviewedVisit, BookingError> {
        if !self.matches_preview(preview) || preview.parts.iter().any(|part| !part.available) {
            return Err(BookingError::SlotUnavailable);
        }
        if preview
            .parts
            .iter()
            .any(|part| part.deposit_waiver_required)
        {
            return Err(BookingError::Rejected);
        }
        Ok(ReviewedVisit {
            packet: self,
            review_hash: preview.review_hash.clone(),
            peak_price_reviews: preview
                .parts
                .iter()
                .any(|part| part.peak_price_review.is_some())
                .then(|| {
                    preview
                        .parts
                        .iter()
                        .map(|part| part.peak_price_review.clone())
                        .collect()
                }),
            expected_starts: preview.parts.iter().map(|part| part.starts_at).collect(),
        })
    }
}

impl ReviewedVisit {
    pub fn mark_local_dispatch(&self, store: &mut Store) -> Result<()> {
        store.mark_local_bookings_dispatch(
            self.packet.parts.iter().map(|part| part.id.as_str()),
            &self.packet.desktop_generation,
        )
    }

    pub(crate) fn acknowledge(
        &self,
        id: &str,
        appointments: &[crate::model::Appointment],
    ) -> Result<VisitConfirmation, BookingError> {
        if self.packet.id != id
            || appointments.iter().any(|appointment| {
                !self
                    .packet
                    .parts
                    .iter()
                    .any(|part| part.id == appointment.id)
            })
        {
            return Err(TransportError::Server("Unexpected visit acknowledgement".into()).into());
        }
        if appointments.len() == self.packet.parts.len()
            && appointments
                .iter()
                .zip(self.packet.parts.iter().zip(&self.expected_starts))
                .all(|(appointment, (part, starts))| {
                    appointment.id == part.id
                        && appointment.staff_id == part.staff_id
                        && appointment.starts_at == *starts
                        && appointment.status == crate::model::AppointmentStatus::Booked
                })
        {
            Ok(VisitConfirmation::Booked(self.packet.starts_at))
        } else {
            Ok(VisitConfirmation::Changed)
        }
    }
}
