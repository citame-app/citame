//! Reviewed, operator-initiated payment allocations for one multi-part visit.
use std::collections::{BTreeMap, BTreeSet};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::model::{Appointment, AppointmentStatus};
use crate::sync::TransportError;

use super::AppointmentCheckout;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VisitSource {
    Itinerary,
    Import,
}

impl VisitSource {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Itinerary => "itinerary",
            Self::Import => "import",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VisitPaymentGroup {
    pub group_id: Uuid,
    pub source: VisitSource,
}

impl VisitPaymentGroup {
    pub fn from_appointment(appointment: &Appointment) -> Option<Self> {
        let (group_id, source) = if let Some(id) = &appointment.itinerary_id {
            (id, VisitSource::Itinerary)
        } else {
            (appointment.visit_group_id.as_ref()?, VisitSource::Import)
        };
        Some(Self {
            group_id: Uuid::parse_str(group_id).ok()?,
            source,
        })
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VisitTender {
    Cash,
    ExternalCard,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VisitPaymentCommand {
    pub method: VisitTender,
    pub review_token: String,
    pub idempotency_key: Uuid,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VisitPaymentAmount {
    pub appointment_id: Uuid,
    pub receipt_id: Uuid,
    pub amount_cents: u32,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedVisitPayment {
    pub group: VisitPaymentGroup,
    pub actor_user_id: String,
    pub command: VisitPaymentCommand,
    pub amounts: Vec<VisitPaymentAmount>,
}

impl SavedVisitPayment {
    pub fn total_cents(&self) -> u64 {
        self.amounts
            .iter()
            .map(|line| u64::from(line.amount_cents))
            .sum()
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisitPart {
    pub appointment_id: Uuid,
    pub staff_name: String,
    pub service_names: Vec<String>,
    pub starts_at: DateTime<Utc>,
    pub status: AppointmentStatus,
    pub settled_externally: bool,
    pub receipt: Option<AppointmentCheckout>,
}

impl VisitPart {
    pub fn eligible(&self) -> bool {
        self.status != AppointmentStatus::Cancelled && !self.settled_externally
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisitReviewToken {
    token: String,
    pub total_cents: u64,
    allocations: Vec<ReviewedAllocation>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewedAllocation {
    receipt_id: Uuid,
    amount_cents: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisitCheckout {
    #[serde(flatten)]
    pub group: VisitPaymentGroup,
    pub appointments: Vec<VisitPart>,
    pub payment_review: Option<VisitReviewToken>,
}

impl VisitCheckout {
    fn reviewed_amounts(&self, review: &VisitReviewToken) -> Option<Vec<VisitPaymentAmount>> {
        let mut unique = BTreeSet::new();
        review
            .allocations
            .iter()
            .map(|line| {
                let part = self.appointments.iter().find(|part| {
                    part.eligible()
                        && part.receipt.as_ref().is_some_and(|receipt| {
                            Uuid::parse_str(&receipt.id).ok() == Some(line.receipt_id)
                                && receipt.status == "open"
                                && line.amount_cents <= receipt.balance_cents
                        })
                })?;
                (line.amount_cents > 0 && unique.insert(line.receipt_id)).then_some(
                    VisitPaymentAmount {
                        appointment_id: part.appointment_id,
                        receipt_id: line.receipt_id,
                        amount_cents: line.amount_cents,
                    },
                )
            })
            .collect()
    }

    pub fn payable_for(&self, receipt: &str) -> Option<u32> {
        let receipt = Uuid::parse_str(receipt).ok()?;
        self.payment_review
            .as_ref()?
            .allocations
            .iter()
            .find(|line| line.receipt_id == receipt)
            .map(|line| line.amount_cents)
    }

    pub(crate) fn matches(&self, group: VisitPaymentGroup, anchor: Uuid) -> bool {
        let appointments: BTreeSet<_> =
            self.appointments.iter().map(|p| p.appointment_id).collect();
        if self.group != group
            || self.appointments.len() < 2
            || appointments.len() != self.appointments.len()
            || !appointments.contains(&anchor)
        {
            return false;
        }
        let mut receipts = BTreeSet::new();
        for part in &self.appointments {
            if let Some(receipt) = &part.receipt
                && (receipt.currency != "EUR"
                    || receipt
                        .appointment_id
                        .as_deref()
                        .and_then(|id| Uuid::parse_str(id).ok())
                        != Some(part.appointment_id)
                    || !Uuid::parse_str(&receipt.id).is_ok_and(|id| receipts.insert(id))
                    || receipt.balance_cents > receipt.total_cents
                    || receipt
                        .payable_cents
                        .is_some_and(|payable| payable > receipt.balance_cents))
            {
                return false;
            }
        }
        self.payment_review.as_ref().is_none_or(|review| {
            review.token.len() == 64
                && review
                    .token
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                && review.total_cents > 0
                && self.reviewed_amounts(review).is_some_and(|amounts| {
                    amounts
                        .iter()
                        .map(|line| u64::from(line.amount_cents))
                        .sum::<u64>()
                        == review.total_cents
                })
        })
    }

    pub fn payment(&self, actor_user_id: String, method: VisitTender) -> Option<SavedVisitPayment> {
        let review = self.payment_review.as_ref()?;
        let amounts = self.reviewed_amounts(review)?;
        Some(SavedVisitPayment {
            group: self.group,
            actor_user_id,
            command: VisitPaymentCommand {
                method,
                review_token: review.token.clone(),
                idempotency_key: Uuid::now_v7(),
            },
            amounts,
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedVisitAllocation {
    pub payment_id: Uuid,
    pub receipt_id: Uuid,
    pub amount_cents: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedVisitPayment {
    pub id: Uuid,
    pub method: VisitTender,
    pub total_cents: u64,
    pub allocations: Vec<RecordedVisitAllocation>,
}

#[derive(Debug, thiserror::Error)]
pub enum VisitPaymentError {
    #[error("The current visit or payment must be reviewed again")]
    Rejected,
    #[error(transparent)]
    Unknown(#[from] TransportError),
}

impl RecordedVisitPayment {
    pub(crate) fn matches(&self, saved: &SavedVisitPayment) -> bool {
        let actual = self
            .allocations
            .iter()
            .map(|line| (line.receipt_id, line.amount_cents))
            .collect::<BTreeMap<_, _>>();
        let expected = saved
            .amounts
            .iter()
            .map(|line| (line.receipt_id, line.amount_cents))
            .collect::<BTreeMap<_, _>>();
        self.method == saved.command.method
            && self.total_cents == saved.total_cents()
            && actual.len() == self.allocations.len()
            && actual == expected
            && self
                .allocations
                .iter()
                .map(|line| line.payment_id)
                .collect::<BTreeSet<_>>()
                .len()
                == self.allocations.len()
    }
}
