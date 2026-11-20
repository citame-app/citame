//! Online booking with a reviewed appointment and intake kept outside the outbox.
use chrono::{DateTime, Utc};
use serde::Serialize;
use std::collections::BTreeMap;

use crate::error::{CoreError, Result};
use crate::intake::IntakeResponse;
use crate::intake::IntakeSelection;
use crate::model::AppointmentService;
use crate::ops::{NewAppointment, reviewed_service_terms, validate_contact};
use crate::store::Store;
use crate::sync::TransportError;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookingTerms {
    #[serde(rename = "desktopGeneration")]
    generation: String,
    id: String,
    staff_id: String,
    service_ids: Vec<String>,
    service_quotes: BTreeMap<String, String>,
    #[serde(skip_serializing)]
    reviewed_services: Vec<AppointmentService>,
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
    intake_review_hash: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    intake_submission_ids: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    intake_responses: Vec<IntakeResponse>,
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
            staff_id: new.staff_id,
            service_ids: new.service_ids,
            service_quotes,
            reviewed_services,
            starts_at: new.starts_at,
            client,
            notes: new.notes,
            override_notice: new.override_notice.then_some(true),
        })
    }

    pub fn service_ids(&self) -> &[String] {
        &self.service_ids
    }
    pub fn client_id(&self) -> Option<&str> {
        match &self.client {
            BookingClient::Existing { id } => Some(id),
            BookingClient::Inline { .. } => None,
        }
    }
    pub fn starts_at(&self) -> DateTime<Utc> {
        self.starts_at
    }
    pub fn generation(&self) -> &str {
        &self.generation
    }
    pub fn services(&self) -> &[AppointmentService] {
        &self.reviewed_services
    }
    pub fn matches_service_quote(&self, id: &str, displayed_quote: &str) -> bool {
        self.service_quotes
            .get(id)
            .is_some_and(|quote| quote == displayed_quote)
    }
    pub fn reviewed(&self, review_hash: String, intake: IntakeSelection) -> ReviewedBooking {
        ReviewedBooking {
            terms: self.clone(),
            intake_review_hash: review_hash,
            intake_submission_ids: intake.saved,
            intake_responses: intake.inline,
        }
    }
}

impl ReviewedBooking {
    /// Keep an opaque origin marker only. The booking and its responses stay in memory.
    pub fn mark_local_dispatch(&self, store: &mut Store) -> Result<()> {
        store.mark_local_booking_dispatch(&self.terms.id, &self.terms.generation)
    }

    pub(crate) fn matches(&self, id: &str, starts_at: DateTime<Utc>) -> bool {
        self.terms.id == id && self.terms.starts_at == starts_at
    }
}
