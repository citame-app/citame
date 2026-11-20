use crate::model::{BillingReviewReason, ExternalBalance};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnpaidRow {
    pub id: Uuid,
    pub client_name: String,
    pub staff_id: Uuid,
    pub starts_at: DateTime<Utc>,
    pub service_names: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DueAppointment {
    #[serde(flatten)]
    pub row: UnpaidRow,
    pub external_balance: Option<ExternalBalance>,
}

#[derive(Debug, Deserialize)]
pub struct BillingReviewRow {
    #[serde(flatten)]
    pub row: UnpaidRow,
    pub reasons: Vec<BillingReviewReason>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnpaidAppointments {
    pub appointments: Vec<DueAppointment>,
    #[serde(default)]
    pub billing_review: Vec<BillingReviewRow>,
}

impl UnpaidAppointments {
    pub(crate) fn valid(&self) -> bool {
        let valid_amount = 1..=999_999_999;
        let mut seen = std::collections::HashSet::new();
        self.appointments.iter().all(|appointment| {
            seen.insert(appointment.row.id)
                && appointment.external_balance.is_none_or(|balance| {
                    valid_amount.contains(&balance.paid_in_booksy_cents)
                        && valid_amount.contains(&balance.due_in_citame_cents)
                })
        }) && self.billing_review.iter().all(|appointment| {
            (1..=3).contains(&appointment.reasons.len()) && seen.insert(appointment.row.id)
        })
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedPricePreview {
    pub appointment_version: i64,
    pub lines: Vec<UnpricedService>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct UnpricedService {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedPriceReview {
    pub appointment_version: i64,
    pub reference: String,
    pub lines: Vec<ReviewedServicePrice>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewedServicePrice {
    pub id: String,
    pub amount_cents: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedSettlement {
    pub appointment_version: i64,
    pub amount_cents: u32,
    pub reference: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedSettlementStatus {
    pub appointment_version: i64,
    pub settlement: Option<RecordedSettlement>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedSettlement {
    pub amount_cents: u32,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum ImportedPartialPaymentPreview {
    Recorded(ImportedPartialPayment),
    Ready(ImportedPartialPaymentTerms),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedPartialPayment {
    pub appointment_version: i64,
    pub external_balance: ExternalBalance,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedPartialPaymentTerms {
    pub appointment_version: i64,
    pub original_total_cents: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppointmentCheckout {
    pub id: String,
    pub appointment_id: String,
    pub currency: String,
    pub status: String,
    pub total_cents: u32,
    pub discount_cents: u32,
    pub paid_cents: u64,
    pub balance_cents: u32,
    pub payable_cents: Option<u32>,
    pub external_balance: Option<ExternalBalance>,
    pub pricing_version: Option<u32>,
    #[serde(default)]
    pub lines: Vec<CheckoutPriceLine>,
    protection: Option<CheckoutProtection>,
    payments: Vec<CheckoutPayment>,
}

impl AppointmentCheckout {
    pub fn can_review_prices(&self) -> bool {
        self.status == "open"
            && self.external_balance.is_none()
            && self.pricing_version.is_some_and(|version| version > 0)
            && self.lines.iter().any(|line| line.price_pending)
            && !self.has_unresolved_payment()
    }

    fn has_unresolved_payment(&self) -> bool {
        self.payments
            .iter()
            .any(|payment| matches!(payment.status.as_str(), "pending" | "reconciliation"))
    }

    pub fn collectible_cents(&self) -> u32 {
        if self.status != "open" || self.has_unresolved_payment() {
            return 0;
        }
        if self.lines.iter().any(|line| line.price_pending) {
            return if self
                .protection
                .as_ref()
                .is_some_and(|p| p.state == "pending")
            {
                self.payable_cents.unwrap_or_default()
            } else {
                0
            };
        }
        self.payable_cents.unwrap_or(self.balance_cents)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutPriceLine {
    pub id: Uuid,
    pub description: String,
    pub unit_amount_cents: u32,
    #[serde(default)]
    pub price_pending: bool,
    #[serde(default)]
    pub minimum_unit_amount_cents: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutFinalPrice {
    pub id: Uuid,
    pub unit_amount_cents: u32,
}

#[derive(Debug, Deserialize)]
struct CheckoutProtection {
    state: String,
}

#[derive(Debug, Deserialize)]
struct CheckoutPayment {
    status: String,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ManualTender {
    Cash,
    ExternalCard,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PaymentAttempt {
    pub(crate) method: ManualTender,
    pub(crate) amount_cents: u32,
    pub(crate) idempotency_key: uuid::Uuid,
}

impl PaymentAttempt {
    pub fn new(method: ManualTender, amount_cents: u32) -> Self {
        Self {
            method,
            amount_cents,
            idempotency_key: uuid::Uuid::now_v7(),
        }
    }

    pub fn amount_cents(self) -> u32 {
        self.amount_cents
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CashSession {
    pub id: uuid::Uuid,
    pub opening_cents: u32,
    pub opened_at: chrono::DateTime<chrono::Utc>,
    pub closed_at: Option<chrono::DateTime<chrono::Utc>>,
    pub expected_cents: i64,
    pub counted_cents: Option<u32>,
    pub difference_cents: Option<i64>,
    pub movements: Vec<CashMovement>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CashMovement {
    pub kind: String,
    pub reason: String,
    pub amount_cents: i64,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CashAdjustment {
    Deposit,
    Withdrawal,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CashCommand {
    Open {
        id: uuid::Uuid,
        opening_cents: u32,
    },
    Close {
        id: uuid::Uuid,
        counted_cents: u32,
        reviewed_expected_cents: i64,
    },
    Adjust {
        id: uuid::Uuid,
        kind: CashAdjustment,
        amount_cents: u32,
        reason: String,
        request_key: uuid::Uuid,
    },
}

impl CashCommand {
    pub fn open(opening_cents: u32) -> Self {
        Self::Open {
            id: uuid::Uuid::now_v7(),
            opening_cents,
        }
    }

    pub fn close(session: &CashSession, counted_cents: u32) -> Self {
        Self::Close {
            id: session.id,
            counted_cents,
            reviewed_expected_cents: session.expected_cents,
        }
    }

    pub fn adjust(
        session: &CashSession,
        kind: CashAdjustment,
        amount_cents: u32,
        reason: String,
    ) -> Self {
        Self::Adjust {
            id: session.id,
            kind,
            amount_cents,
            reason,
            request_key: uuid::Uuid::now_v7(),
        }
    }
}

/// Convert the labelled EUR amount without float rounding or ambiguous thousands separators.
pub fn parse_reviewed_amount(text: &str) -> Option<u32> {
    let text = text.trim();
    let (whole, decimals) = text.split_once(['.', ',']).unwrap_or((text, "00"));
    if !(1..=7).contains(&whole.len())
        || !(1..=2).contains(&decimals.len())
        || !whole
            .bytes()
            .chain(decimals.bytes())
            .all(|c| c.is_ascii_digit())
    {
        return None;
    }
    let scale = if decimals.len() == 1 { 10 } else { 1 };
    Some(whole.parse::<u32>().ok()? * 100 + decimals.parse::<u32>().ok()? * scale)
}

#[cfg(test)]
mod tests {
    use super::{AppointmentCheckout, parse_reviewed_amount};
    use serde_json::json;

    #[test]
    fn pending_prices_allow_only_an_explicit_protected_deposit() {
        let mut response = json!({
            "id":"receipt", "appointmentId":"appointment", "currency":"EUR", "status":"open",
            "totalCents": 3000, "discountCents": 0, "paidCents": 0, "balanceCents": 3000,
            "pricingVersion": 1, "payments": [],
            "lines": [{
                "id": "01a1d81f-2231-75bd-ba65-bc41f42803e9", "description": "Treatment",
                "unitAmountCents": 3000, "minimumUnitAmountCents": 3000, "pricePending": true
            }]
        });
        let read = |v| serde_json::from_value::<AppointmentCheckout>(v).unwrap();
        assert_eq!(read(response.clone()).collectible_cents(), 0);
        response["protection"] = json!({ "state": "pending" });
        assert_eq!(read(response.clone()).collectible_cents(), 0);
        response["payableCents"] = json!(1500);
        assert_eq!(read(response.clone()).collectible_cents(), 1500);
        response["protection"] = json!({ "state": "confirmed" });
        assert_eq!(read(response).collectible_cents(), 0);
    }

    #[test]
    fn verified_euro_amounts_are_exact_and_unambiguous() {
        assert_eq!(parse_reviewed_amount("36,50"), Some(3650));
        assert_eq!(parse_reviewed_amount(" 36.5 "), Some(3650));
        assert_eq!(parse_reviewed_amount("0"), Some(0));
        assert_eq!(parse_reviewed_amount("9999999,99"), Some(999999999));
        for invalid in ["", "1,", "1.234", "3,50.00", "-1", "10000000", "1e2"] {
            assert_eq!(parse_reviewed_amount(invalid), None, "{invalid}");
        }
    }
}
