use crate::intake::{IntakeResponse, IntakeSelection};
use crate::model::CatalogPrice;
use crate::sync::TransportError;
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

impl WaitlistOffer {
    pub fn total_price_type(&self) -> CatalogPrice {
        if self
            .services
            .iter()
            .any(|service| service.price_type == CatalogPrice::Variable)
        {
            CatalogPrice::Variable
        } else if self
            .services
            .iter()
            .any(|service| service.price_type == CatalogPrice::From)
        {
            CatalogPrice::From
        } else {
            CatalogPrice::Fixed
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OfferedService {
    pub name: String,
    pub price_cents: u32,
    pub peak_surcharge_cents: Option<u32>,
    #[serde(default)]
    pub price_type: CatalogPrice,
    pub client_instructions: Option<String>,
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

#[derive(Debug, thiserror::Error)]
pub enum AcceptOfferError {
    #[error("the offer needs to be reviewed against the current forms")]
    IntakeChanged,
    #[error("the server reached its saved response limit")]
    ResponseLimit,
    #[error("the offer acceptance was rejected")]
    Rejected,
    #[error(transparent)]
    Transport(#[from] TransportError),
}

#[derive(Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcceptOffer {
    pub version: u32,
    pub offer_id: String,
    pub expected_total_cents: u32,
    pub idempotency_key: String,
    pub intake_review_hash: String,
    pub intake_submission_ids: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub intake_responses: Vec<IntakeResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protection_waiver_reason: Option<String>,
}

impl WaitlistEntry {
    pub fn reviewable_offer(
        &self,
        now: DateTime<Utc>,
        can_waive: bool,
        reason: &str,
    ) -> Option<&WaitlistOffer> {
        let offer = self.offer.as_ref()?;
        (self.can_manage
            && self.state == WaitlistState::Offered
            && offer.expires_at > now
            && (!offer.policy.enabled
                || (can_waive && (8..=300).contains(&reason.trim().encode_utf16().count()))))
        .then_some(offer)
    }

    pub fn reviewed_acceptance(
        &self,
        now: DateTime<Utc>,
        can_waive: bool,
        waiver: &str,
        review_hash: String,
        intake: IntakeSelection,
    ) -> Option<AcceptOffer> {
        let offer = self.reviewable_offer(now, can_waive, waiver)?;
        Some(AcceptOffer {
            version: self.version,
            offer_id: offer.id.clone(),
            expected_total_cents: offer.price_cents,
            idempotency_key: WaitlistRequest::new_key(),
            intake_review_hash: review_hash,
            intake_submission_ids: intake.saved,
            intake_responses: intake.inline,
            protection_waiver_reason: offer.policy.enabled.then(|| waiver.trim().to_owned()),
        })
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn legacy_cached_offer_has_fixed_prices_and_no_instructions() {
        let service: OfferedService = serde_json::from_value(json!({
            "name": "Legacy treatment",
            "priceCents": 2000,
            "currency": "EUR"
        }))
        .unwrap();
        assert_eq!(service.price_type, CatalogPrice::Fixed);
        assert_eq!(service.client_instructions, None);
    }

    #[test]
    fn offers_keep_service_terms_and_promote_any_variable_price_to_pending() {
        let mut offer: WaitlistOffer = serde_json::from_value(json!({
            "id": "offer",
            "staffId": "staff",
            "startsAt": "2026-11-24T12:00:00Z",
            "endsAt": "2026-11-24T13:00:00Z",
            "expiresAt": "2026-11-24T11:45:00Z",
            "priceCents": 3200,
            "currency": "EUR",
            "services": [
                { "name": "Treatment", "priceCents": 3200, "currency": "EUR", "priceType": "from",
                  "peakSurchargeCents": 200, "clientInstructions": "Arrive ten minutes early.\nBring the intake form." },
                { "name": "Consultation", "priceCents": 0, "currency": "EUR", "priceType": "variable" }
            ],
            "policy": { "enabled": false }
        }))
        .unwrap();
        assert_eq!(offer.total_price_type(), CatalogPrice::Variable);
        assert_eq!(
            offer.services[0].client_instructions.as_deref(),
            Some("Arrive ten minutes early.\nBring the intake form.")
        );
        assert_eq!(offer.services[0].peak_surcharge_cents, Some(200));
        let round_trip: WaitlistOffer =
            serde_json::from_str(&serde_json::to_string(&offer).unwrap()).unwrap();
        assert_eq!(round_trip, offer);
        offer.services.pop();
        assert_eq!(offer.total_price_type(), CatalogPrice::From);
        offer.services[0].price_type = CatalogPrice::Hidden;
        assert_eq!(offer.total_price_type(), CatalogPrice::Fixed);
    }
}
