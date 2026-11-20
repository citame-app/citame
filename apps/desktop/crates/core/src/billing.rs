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
    pub appointment_id: Option<String>,
    client_id: Option<Uuid>,
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
    fulfilled_at: Option<DateTime<Utc>>,
    payments: Vec<CheckoutPayment>,
    #[serde(default)]
    pub can_refund: bool,
    #[serde(default)]
    pub refunds: Vec<CheckoutRefund>,
}

impl AppointmentCheckout {
    pub fn recordable_refunds_available(&self) -> impl Iterator<Item = RefundablePayment> + '_ {
        self.payments.iter().filter_map(|payment| {
            if !self.can_refund || payment.status != "succeeded" {
                return None;
            }
            let id = payment.id?;
            let tender = match payment.method.as_deref()? {
                "cash" => ReceiptTender::Cash,
                "external_card" => ReceiptTender::ExternalCard,
                "gift_card" => ReceiptTender::GiftCard,
                "package" => ReceiptTender::Package,
                "membership" => ReceiptTender::Membership,
                _ => return None,
            };
            let already_committed: u64 = self
                .refunds
                .iter()
                .filter(|refund| refund.payment_id == id && refund.status != "failed")
                .map(|refund| u64::from(refund.amount_cents))
                .sum();
            let available =
                u64::from(payment.amount_cents).saturating_sub(already_committed) as u32;
            (available > 0).then_some(RefundablePayment {
                id,
                tender,
                available,
            })
        })
    }

    pub fn allows_gift_card(&self) -> bool {
        self.external_balance.is_none() && self.lines.iter().all(|line| line.kind != "gift_card")
    }

    pub fn allows_pass(&self) -> bool {
        self.appointment_id.is_some()
            && self.client_id.is_some()
            && self.external_balance.is_none()
            && self.collectible_cents() > 0
            && !self
                .protection
                .as_ref()
                .is_some_and(|p| p.state == "pending")
    }

    pub fn can_void(&self) -> bool {
        self.status == "open"
            && self.fulfilled_at.is_none()
            && self.protection.is_none()
            && self.paid_cents == 0
            && self
                .payments
                .iter()
                .all(|payment| payment.status == "failed")
    }

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
    #[serde(default)]
    kind: String,
    pub description: String,
    pub quantity: u32,
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

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum SaleItem {
    Service {
        service_id: Uuid,
        quantity: u32,
    },
    Product {
        product_id: Uuid,
        quantity: u32,
    },
    Custom {
        description: String,
        unit_amount_cents: u32,
        quantity: u32,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalkInSale {
    pub idempotency_key: Uuid,
    pub lines: Vec<SaleItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub staff_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub use_client_discount: Option<bool>,
    pub discount_cents: u32,
    pub tip_cents: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutSummary {
    pub id: Uuid,
    pub created_at: DateTime<Utc>,
    pub currency: String,
    pub status: String,
    pub total_cents: u32,
    pub lines: Vec<CheckoutPriceLine>,
}

#[derive(Clone, Debug, Default)]
pub struct CheckoutHistoryFilters {
    pub search: String,
    pub status: Option<&'static str>,
    pub method: Option<&'static str>,
    pub from: Option<DateTime<Utc>>,
    pub to: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
pub struct CheckoutPage {
    pub checkouts: Vec<CheckoutSummary>,
    pub total: u64,
}

#[derive(Debug, Deserialize)]
struct CheckoutProtection {
    state: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckoutPayment {
    id: Option<Uuid>,
    method: Option<String>,
    #[serde(default)]
    amount_cents: u32,
    status: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutRefund {
    pub id: Uuid,
    pub payment_id: Uuid,
    pub amount_cents: u32,
    pub status: String,
    pub reason: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RefundablePayment {
    pub id: Uuid,
    pub tender: ReceiptTender,
    pub available: u32,
}

impl RefundablePayment {
    pub fn is_full_visit(self) -> bool {
        matches!(
            self.tender,
            ReceiptTender::Package | ReceiptTender::Membership
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefundAttempt {
    pub(crate) idempotency_key: Uuid,
    pub(crate) amount_cents: u32,
    pub(crate) reason: String,
}

impl RefundAttempt {
    pub fn new(amount_cents: u32, reason: &str) -> Option<Self> {
        let reason = reason.trim();
        ((1..=999_999_999).contains(&amount_cents)
            && (3..=300).contains(&reason.encode_utf16().count()))
        .then(|| Self {
            idempotency_key: Uuid::now_v7(),
            amount_cents,
            reason: reason.to_owned(),
        })
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReceiptTender {
    Cash,
    ExternalCard,
    GiftCard,
    Package,
    Membership,
}

#[derive(Clone, Debug)]
pub struct EligiblePassUse {
    pub(super) period_id: Uuid,
    pub(super) line_id: Uuid,
    pub kind: ReceiptTender,
    pub name: String,
    pub description: String,
    pub amount_cents: u32,
}

#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentAttempt {
    pub(crate) method: ReceiptTender,
    pub(crate) amount_cents: u32,
    pub(crate) idempotency_key: uuid::Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) gift_card_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pass_period_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) checkout_line_id: Option<Uuid>,
}

impl PaymentAttempt {
    pub fn new(method: ReceiptTender, amount_cents: u32) -> Self {
        Self {
            method,
            amount_cents,
            idempotency_key: uuid::Uuid::now_v7(),
            gift_card_code: None,
            pass_period_id: None,
            checkout_line_id: None,
        }
    }

    pub fn with_gift_card(amount_cents: u32, code: &str) -> Option<Self> {
        let mut attempt = Self::new(ReceiptTender::GiftCard, amount_cents);
        attempt.gift_card_code = Some(normalize_gift_card_code(code)?);
        Some(attempt)
    }

    pub fn for_pass(choice: &EligiblePassUse) -> Self {
        let mut attempt = Self::new(choice.kind, choice.amount_cents);
        attempt.pass_period_id = Some(choice.period_id);
        attempt.checkout_line_id = Some(choice.line_id);
        attempt
    }

    pub fn tender(&self) -> ReceiptTender {
        self.method
    }

    pub fn amount_cents(&self) -> u32 {
        self.amount_cents
    }
}

pub fn normalize_gift_card_code(value: &str) -> Option<String> {
    if value.encode_utf16().count() > 80 {
        return None;
    }
    let code = value.trim().to_uppercase().replace([' ', '-'], "");
    code.strip_prefix("SOB")
        .is_some_and(|suffix| suffix.len() == 24 && suffix.bytes().all(|b| b.is_ascii_hexdigit()))
        .then_some(code)
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
                "quantity": 1, "unitAmountCents": 3000, "minimumUnitAmountCents": 3000, "pricePending": true
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
