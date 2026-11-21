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
    pub created_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub tip_cents: u32,
    #[serde(default)]
    pub tax_cents: u32,
    #[serde(default)]
    pub refunded_cents: u64,
    #[serde(default)]
    pub overpaid_cents: u64,
    pub reward: Option<ReceiptReward>,
    pub balance_cents: u32,
    pub payable_cents: Option<u32>,
    pub external_balance: Option<ExternalBalance>,
    pub pricing_version: Option<u32>,
    #[serde(default)]
    pub lines: Vec<CheckoutPriceLine>,
    protection: Option<CheckoutProtection>,
    fulfilled_at: Option<DateTime<Utc>>,
    stock_return_generation: Option<String>,
    payments: Vec<CheckoutPayment>,
    #[serde(default)]
    pub can_refund: bool,
    #[serde(default)]
    can_dispatch_bank_refunds: bool,
    pub refund_review_generation: Option<String>,
    #[serde(default)]
    pub refunds: Vec<CheckoutRefund>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptReward {
    pub kind: crate::loyalty::checkout::RewardKind,
    pub name: String,
    pub code: Option<String>,
    pub points_used: u32,
    #[serde(default)]
    pub returned_points: u32,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub discount_cents: u32,
    pub appointment_timing: Option<crate::loyalty::checkout::AppointmentTiming>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaymentAttention {
    Pending,
    Reconciliation,
}

impl AppointmentCheckout {
    pub fn reward_client(&self) -> Option<Uuid> {
        (self.status == "open"
            && self.total_cents > 0
            && self.fulfilled_at.is_none()
            && self.external_balance.is_none()
            && self.reward.is_none()
            && self.payments.is_empty()
            && self.lines.iter().all(|line| !line.price_pending)
            && self
                .lines
                .iter()
                .any(|line| matches!(line.kind.as_str(), "service" | "product" | "custom")))
        .then_some(self.client_id)
        .flatten()
    }

    pub fn can_return_points(&self) -> bool {
        self.can_refund
            && self.fulfilled_at.is_some()
            && self.refunded_cents >= self.paid_cents
            && self.reward.as_ref().is_some_and(|reward| {
                reward.kind == crate::loyalty::checkout::RewardKind::Points
                    && reward.state == "applied"
                    && reward.points_used > reward.returned_points
            })
    }

    pub fn reconcilable_bank_payments(
        &self,
        now: DateTime<Utc>,
    ) -> impl Iterator<Item = PendingBankPayment> + '_ {
        self.payments.iter().filter_map(move |payment| {
            let method = BankPaymentMethod::from_api(payment.method.as_deref()?)?;
            let bank_order = payment.order.as_deref().filter(|order| !order.is_empty())?;
            let reconcile_after = payment.reconcile_after?;
            (self.can_refund && payment.status == "pending" && now >= reconcile_after).then_some(
                PendingBankPayment {
                    id: payment.id?,
                    method,
                    amount_cents: payment.amount_cents,
                    bank_order: bank_order.to_owned(),
                    merchant_initiated: payment.merchant_initiated,
                },
            )
        })
    }

    pub(super) fn bank_payment_status(&self, id: Uuid) -> Option<&str> {
        self.payments
            .iter()
            .find(|payment| payment.id == Some(id))
            .map(|payment| payment.status.as_str())
    }

    pub fn recordable_refunds_available(&self) -> impl Iterator<Item = RefundablePayment> + '_ {
        self.payments.iter().filter_map(|payment| {
            if !self.can_refund {
                return None;
            }
            let id = payment.id?;
            let tender = match (payment.method.as_deref()?, payment.status.as_str()) {
                ("cash", "succeeded") => RefundTender::Manual(ReceiptTender::Cash),
                ("external_card", "succeeded") => RefundTender::Manual(ReceiptTender::ExternalCard),
                ("gift_card", "succeeded") => RefundTender::Manual(ReceiptTender::GiftCard),
                ("package", "succeeded") => RefundTender::Manual(ReceiptTender::Package),
                ("membership", "succeeded") => RefundTender::Manual(ReceiptTender::Membership),
                (method, "succeeded" | "reconciliation")
                    if payment
                        .order
                        .as_deref()
                        .is_some_and(|order| !order.is_empty()) =>
                {
                    RefundTender::Bank(BankPaymentMethod::from_api(method)?)
                }
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
                pass_period_id: self.lines.iter().find_map(|line| line.pass_period_id),
            })
        })
    }

    pub fn reviewable_bank_refunds(
        &self,
        now: DateTime<Utc>,
    ) -> impl Iterator<Item = BankRefund> + '_ {
        self.refunds
            .iter()
            .filter_map(move |refund| {
                if !self.can_refund {
                    return None;
                }
                let payment = self
                    .payments
                    .iter()
                    .find(|payment| payment.id == Some(refund.payment_id))?;
                let order = payment.order.as_deref().filter(|order| !order.is_empty());
                let action = match refund.status.as_str() {
                    "requested" if self.can_dispatch_bank_refunds && order.is_some() => {
                        BankRefundAction::Dispatch
                    }
                    "requested" => BankRefundAction::Cancel,
                    "dispatched" | "reconciliation"
                        if order.is_some()
                            && refund.reconcile_after.is_some_and(|after| now >= after) =>
                    {
                        BankRefundAction::Reconcile
                    }
                    _ => return None,
                };
                Some(BankRefund {
                    id: refund.id,
                    payment_id: refund.payment_id,
                    amount_cents: refund.amount_cents,
                    reason: refund.reason.clone(),
                    bank_order: order.map(str::to_owned),
                    method: BankPaymentMethod::from_api(payment.method.as_deref()?)?,
                    action,
                })
            })
            .flat_map(|refund| {
                let cancellation =
                    (refund.action == BankRefundAction::Dispatch).then(|| BankRefund {
                        action: BankRefundAction::Cancel,
                        ..refund.clone()
                    });
                std::iter::once(refund).chain(cancellation)
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

    pub fn returnable_products(&self) -> impl Iterator<Item = &CheckoutPriceLine> {
        self.lines.iter().filter(|line| {
            self.fulfilled_at.is_some()
                && self.stock_return_generation.is_some()
                && line.kind == "product"
                && line.product_id.is_some()
                && line.quantity > 0
        })
    }

    pub fn stock_return_obsolete(&self, attempt: &crate::inventory::StockReturnAttempt) -> bool {
        self.id.parse().ok() == Some(attempt.receipt_id)
            && self
                .stock_return_generation
                .as_ref()
                .is_some_and(|generation| generation != &attempt.command.generation)
    }

    pub fn stock_return(
        &self,
        line_id: Uuid,
        quantity: u32,
        reason: &str,
        actor_user_id: String,
    ) -> Option<crate::inventory::StockReturnAttempt> {
        let line = self.returnable_products().find(|line| line.id == line_id)?;
        let reason = reason.trim();
        if !crate::inventory::StockReturnAttempt::valid_input(quantity, line.quantity, reason) {
            return None;
        }
        Some(crate::inventory::StockReturnAttempt {
            product_id: line.product_id?,
            receipt_id: self.id.parse().ok()?,
            command: crate::inventory::StockReturnCommand {
                checkout_line_id: line_id,
                quantity,
                reason: reason.to_owned(),
                generation: self.stock_return_generation.clone()?,
                actor_user_id,
                idempotency_key: Uuid::now_v7(),
            },
        })
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
        self.payment_attention().is_some()
    }

    pub fn payment_attention(&self) -> Option<PaymentAttention> {
        if self
            .payments
            .iter()
            .any(|payment| payment.status == "reconciliation")
        {
            return Some(PaymentAttention::Reconciliation);
        }
        self.payments
            .iter()
            .any(|payment| payment.status == "pending")
            .then_some(PaymentAttention::Pending)
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
    product_id: Option<Uuid>,
    pass_period_id: Option<Uuid>,
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
    pub client_id: Option<Uuid>,
    pub status: Option<&'static str>,
    pub method: Option<&'static str>,
    pub from: Option<DateTime<Utc>>,
    pub to: Option<DateTime<Utc>>,
    pub group_by: Option<CheckoutHistoryGroup>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CheckoutHistoryGroup {
    Day,
    Month,
}

impl CheckoutHistoryGroup {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Day => "day",
            Self::Month => "month",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutPage {
    pub checkouts: Vec<CheckoutSummary>,
    pub total: u64,
    pub group_totals: Option<CheckoutGroupTotals>,
}

#[derive(Debug, Deserialize)]
pub struct CheckoutGroupTotals {
    pub timezone: String,
    pub rows: Vec<CheckoutGroupTotal>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutGroupTotal {
    pub period: chrono::NaiveDate,
    pub receipts: u64,
    pub paid_cents: i64,
    pub refunded_cents: i64,
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
    order: Option<String>,
    reconcile_after: Option<DateTime<Utc>>,
    #[serde(default)]
    merchant_initiated: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BankPaymentMethod {
    Card,
    Bizum,
}

impl BankPaymentMethod {
    fn from_api(method: &str) -> Option<Self> {
        match method {
            "redsys_card" => Some(Self::Card),
            "redsys_bizum" => Some(Self::Bizum),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingBankPayment {
    pub id: Uuid,
    pub method: BankPaymentMethod,
    pub amount_cents: u32,
    pub bank_order: String,
    pub merchant_initiated: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BankPaymentOutcome {
    Succeeded,
    Failed,
}

impl BankPaymentOutcome {
    pub(super) fn matches_status(self, status: &str) -> bool {
        match self {
            Self::Succeeded => matches!(status, "succeeded" | "reconciliation"),
            Self::Failed => status == "failed",
        }
    }
}

#[derive(Debug, Serialize)]
pub struct BankPaymentReconciliation {
    pub(super) outcome: BankPaymentOutcome,
    reference: String,
}

impl BankPaymentReconciliation {
    pub fn new(outcome: BankPaymentOutcome, reference: &str) -> Option<Self> {
        let reference = reference.trim();
        (8..=300)
            .contains(&reference.encode_utf16().count())
            .then(|| Self {
                outcome,
                reference: reference.to_owned(),
            })
    }
}

pub struct BankPaymentResolution {
    pub receipt: AppointmentCheckout,
    pub bank_outcome_changed: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutRefund {
    pub id: Uuid,
    pub payment_id: Uuid,
    pub amount_cents: u32,
    pub status: String,
    pub reason: String,
    pub cancelled_at: Option<DateTime<Utc>>,
    reconcile_after: Option<DateTime<Utc>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BankRefundAction {
    Dispatch,
    Cancel,
    Reconcile,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BankRefund {
    pub id: Uuid,
    pub payment_id: Uuid,
    pub amount_cents: u32,
    pub reason: String,
    pub bank_order: Option<String>,
    pub method: BankPaymentMethod,
    pub action: BankRefundAction,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RefundTender {
    Manual(ReceiptTender),
    Bank(BankPaymentMethod),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RefundablePayment {
    pub id: Uuid,
    pub tender: RefundTender,
    pub available: u32,
    pub pass_period_id: Option<Uuid>,
}

impl RefundablePayment {
    pub fn is_full_visit(self) -> bool {
        matches!(
            self.tender,
            RefundTender::Manual(ReceiptTender::Package | ReceiptTender::Membership)
        )
    }

    pub fn covers_amount(self, cents: u32) -> bool {
        (1..=self.available).contains(&cents) && (!self.is_full_visit() || cents == self.available)
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefundAttempt {
    pub(crate) idempotency_key: Uuid,
    pub(crate) amount_cents: u32,
    pub(crate) reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) pass_quote: Option<PassRefundSelection>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PassRefundSelection {
    pub period_id: Uuid,
    pub unit_count: u32,
    pub generation: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PassRefundQuote {
    pub amount_cents: u32,
    pub unit_count: u32,
    pub excess_cents: u32,
    pub available_uses: u32,
    #[serde(default)]
    pub access_fee: bool,
}

impl PassRefundQuote {
    pub(crate) const MAX_VISITS: u32 = 1000;

    pub fn parse_visit_count(text: &str) -> Option<u32> {
        if text.len() > 4 || !text.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        text.parse().ok().filter(|count| *count <= Self::MAX_VISITS)
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BankRefundReviewContext {
    pub checkout_id: Uuid,
    pub actor_user_id: String,
    pub generation: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub struct ReviewedBankRefund {
    #[serde(flatten)]
    pub attempt: RefundAttempt,
    pub review: BankRefundReviewContext,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub struct SavedBankRefund {
    pub payment_id: Uuid,
    pub method: BankPaymentMethod,
    pub request: ReviewedBankRefund,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SavedBankRefundStatus {
    Ready,
    Obsolete,
    Unavailable,
}

impl SavedBankRefund {
    pub fn status(&self, receipt: &AppointmentCheckout) -> SavedBankRefundStatus {
        if receipt.id.parse().ok() != Some(self.request.review.checkout_id) {
            return SavedBankRefundStatus::Unavailable;
        }
        match receipt.refund_review_generation.as_deref() {
            Some(generation) if generation == self.request.review.generation => {
                SavedBankRefundStatus::Ready
            }
            Some(_) => SavedBankRefundStatus::Obsolete,
            None => SavedBankRefundStatus::Unavailable,
        }
    }
}

impl RefundAttempt {
    pub fn amount_cents(&self) -> u32 {
        self.amount_cents
    }

    pub fn reason(&self) -> &str {
        &self.reason
    }
    pub fn pass_selection(&self) -> Option<&PassRefundSelection> {
        self.pass_quote.as_ref()
    }
    pub fn from_pass_quote(
        quote: &PassRefundQuote,
        reason: &str,
        period_id: Uuid,
        generation: String,
    ) -> Option<Self> {
        let mut attempt = Self::new(quote.amount_cents, reason)?;
        attempt.pass_quote = Some(PassRefundSelection {
            period_id,
            unit_count: quote.unit_count,
            generation,
        });
        Some(attempt)
    }
    pub fn new(amount_cents: u32, reason: &str) -> Option<Self> {
        let reason = reason.trim();
        ((1..=999_999_999).contains(&amount_cents)
            && (3..=300).contains(&reason.encode_utf16().count()))
        .then(|| Self {
            idempotency_key: Uuid::now_v7(),
            amount_cents,
            reason: reason.to_owned(),
            pass_quote: None,
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
