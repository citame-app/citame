//! HTTP transport for the sync protocol and the SSE nudge listener.

use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use crate::auth::{AuthError, AuthProvider, BrowserWorkspace, SessionHandle, TokenStore};
use crate::backoff::Backoff;
use crate::billing::{
    AppointmentCheckout, BankPaymentReconciliation, BankPaymentResolution, BankRefundAction,
    CashCommand, CashSession, CheckoutFinalPrice, CheckoutHistoryFilters, CheckoutPage,
    CheckoutRefund, EligiblePassUse, ImportedPartialPayment, ImportedPartialPaymentPreview,
    ImportedPricePreview, ImportedPriceReview, ImportedSettlement, ImportedSettlementStatus,
    PassRefundQuote, PaymentAttempt, ReceiptTender, RefundAttempt, RefundTender, SavedBankRefund,
    SavedBankRefundStatus, WalkInSale,
};
use crate::booking::visit::{ReviewedVisit, VisitConfirmation, VisitPacket, VisitPreview};
use crate::booking::{
    BookingAttempt, BookingConfirmation, BookingError, BookingTerms, ReviewedBooking,
    ReviewedSeries, SeriesPacket, SeriesPreview,
};
use crate::booking_policy::{PolicyWriteError, ReviewedBookingPolicy};
use crate::intake::{
    AdminForm, AdminFormSummary, AdminForms, FormWrite, FormWriteError, IntakeRequirements,
    recovered_form,
};
use crate::inventory::{
    ContentWriteError, InventoryFacets, InventoryReport, LedgerPage, LedgerQuery, MovementPage,
    PRODUCTS_PATH, PackageContent, PendingStock, Product, ProductId, ProductPage, ProductQuery,
    StockReturnAttempt, StockWriteError,
};
use crate::model::*;
use crate::reports::commissions::{
    CommissionPayoutError, CommissionPolicy, CommissionRateEdit, CommissionScope,
    CommissionStatement, RecordedCommissionPayout, SavedCommissionPayout,
};
use crate::reports::{
    ClientReport, Outcome, OutcomePage, ReportQuery, ReportSummary, financial::FinancialReport,
};
use crate::reviews::{
    self, EmailStatus, ManagedReview, ModerationCommand, ReviewEmail, ReviewPage, ReviewRequests,
    ReviewStatus,
};
use crate::runner::Wake;
use crate::sse::{SseParser, nudge_seq};
use crate::sync::{CatalogColors, CatalogueSnapshots, Transport, TransportError};
use crate::waitlist::{
    AcceptOffer, AcceptOfferError, AcceptedOffer, BookedAppointment, WaitlistEntry, WaitlistPage,
    WaitlistPolicy, WaitlistRequest,
};

pub struct HttpTransport {
    base_url: String,
    agent: ureq::Agent,
    stream_agent: ureq::Agent,
    session: SessionHandle,
    auth: Arc<dyn AuthProvider>,
    authorization: Mutex<bool>,
    token_store: Option<Arc<dyn TokenStore>>,
}

mod booking_links;
pub mod client_controls;
pub mod email_delivery;
mod inventory_documents;
mod loyalty;
pub mod marketing;
mod portfolio;
mod promotions;
mod service_catalog;
mod service_catalog_form;
mod service_resources;
mod staff_access;
mod staff_portraits;
mod warehouses;
pub mod whatsapp;
pub use crate::model::{CatalogPrice, ServiceOption};
pub use portfolio::{
    PORTFOLIO_LIVE_TOPIC, PORTFOLIO_UPLOAD, PortfolioEdit, PortfolioList, PortfolioPhoto,
    PortfolioPublication, PortfolioStatus, QueuedPortfolioUpload,
};
pub use service_catalog::{
    CatalogService, CatalogWriteError, NewCatalogService, ReviewedCatalog, ServiceCreation,
    ServiceDetails,
};
pub use service_catalog_form::{CatalogForm, ServiceField};
pub use staff_access::{
    AccessPreset, AccountRole, ReviewedStaffAccess, StaffAccess, StaffAccountError,
    valid_staff_login,
};
mod unlinked_accounts;
pub use staff_portraits::{PortraitDirectory, PortraitStaff, PortraitUpdate};
pub use unlinked_accounts::{AccountLookupError, AccountRoleReceipt, UnlinkedAccount};
mod weekly_hours;
pub use weekly_hours::{WeeklyHours, WeeklyRange, parse_weekly_hours};
mod date_shifts;
mod intake_records;
mod salon_configuration;
pub use date_shifts::{
    DatedShiftConflict, DatedShiftConflictReason, DatedShiftCopy, DatedShiftDay, DatedShiftEdit,
    DatedShiftReview, DatedShiftSelection, ReviewedDatedShift,
};
pub use salon_configuration::{
    ReviewedSalonConfiguration, SALON_SLOT_STEPS, SalonConfiguration, SalonConfigurationDraft,
    SalonConfigurationWrite,
};

/// The stream is reconnected at least this often. ureq bounds the whole body, not each read,
/// so this doubles as dead-connection detection (the server pings every 15 s).
const STREAM_BODY_BUDGET: Duration = Duration::from_secs(90);

#[derive(Clone, Copy)]
enum BankRefundOperation<'a> {
    Dispatch,
    Cancel,
    Reconcile(&'a BankPaymentReconciliation),
}

impl HttpTransport {
    pub fn new(base_url: &str, session: SessionHandle, auth: Arc<dyn AuthProvider>) -> Self {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .max_redirects(0)
            .timeout_global(Some(Duration::from_secs(30)))
            .build()
            .into();
        let stream_agent: ureq::Agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .max_redirects(0)
            .timeout_connect(Some(Duration::from_secs(10)))
            .timeout_recv_response(Some(Duration::from_secs(15)))
            .timeout_recv_body(Some(STREAM_BODY_BUDGET))
            .build()
            .into();
        Self {
            base_url: base_url.trim_end_matches('/').to_owned(),
            agent,
            stream_agent,
            session,
            auth,
            authorization: Mutex::new(false),
            token_store: None,
        }
    }

    pub fn with_token_store(mut self, token_store: Arc<dyn TokenStore>) -> Self {
        self.token_store = Some(token_store);
        self
    }

    fn headers(&self) -> Result<Vec<(String, String)>, TransportError> {
        // SSE and REST share one rotating refresh token, without holding the UI lock over I/O.
        let mut pending_save = self.authorization.lock().expect("authorization lock");
        let previous = self
            .session
            .read()
            .expect("session lock")
            .clone()
            .ok_or(TransportError::Unauthorized)?;
        let mut session = previous.clone();
        let headers = self
            .auth
            .authorize(&mut session)
            .map_err(|error| match error {
                AuthError::InvalidCredentials | AuthError::WrongRole(_) => {
                    TransportError::Unauthorized
                }
                other => TransportError::Offline(other.to_string()),
            })?;
        if session != previous || *pending_save {
            let mut current = self.session.write().expect("session lock");
            if current.as_ref() != Some(&previous) {
                drop(current);
                self.auth.sign_out(&session);
                return Err(TransportError::Unauthorized);
            }
            if let Some(store) = &self.token_store
                && let Err(error) = store.save(&session)
            {
                // Keep the rotated token in memory even if the local write failed.
                *current = Some(session);
                *pending_save = true;
                return Err(TransportError::Offline(error.to_string()));
            }
            *current = Some(session);
            *pending_save = false;
        }
        Ok(headers)
    }

    pub fn appointment_annotations(
        &self,
        id: &str,
    ) -> Result<AppointmentAnnotations, TransportError> {
        let path = format!("/appointments/{}/context", parse_id(id)?);
        read_response(self.get(&self.agent, &path, None)?, false)
    }

    pub fn update_service_annotations(
        &self,
        id: &str,
        input: &UpdateServiceAnnotations,
    ) -> Result<Option<AppointmentAnnotations>, TransportError> {
        let id = parse_id(id)?;
        let mut request = self
            .agent
            .patch(&format!("{}/appointments/{id}/context", self.base_url));
        for (key, value) in self.headers()? {
            request = request.header(key, value);
        }
        let body = serde_json::to_string(input)
            .map_err(|_| TransportError::BadRequest("Invalid appointment note".into()))?;
        let response = request
            .content_type("application/json")
            .send(body)
            .map_err(|e| TransportError::Offline(e.to_string()))?;
        if response.status().as_u16() == 409 {
            return Ok(None);
        }
        read_response(response, false).map(Some)
    }

    pub fn imported_price_preview(&self, id: &str) -> Result<ImportedPricePreview, TransportError> {
        let path = format!(
            "/admin/commerce/appointments/{}/imported-price",
            parse_id(id)?
        );
        read_response(self.get(&self.agent, &path, None)?, false)
    }

    pub fn review_imported_price(
        &self,
        id: &str,
        review: &ImportedPriceReview,
    ) -> Result<(), TransportError> {
        #[derive(serde::Deserialize)]
        struct Saved {
            ok: bool,
        }
        let path = format!(
            "/admin/commerce/appointments/{}/imported-price",
            parse_id(id)?
        );
        let saved: Saved = self.put_json(&path, review)?;
        if !saved.ok {
            return Err(TransportError::Server(
                "Invalid price review acknowledgement".into(),
            ));
        }
        Ok(())
    }

    pub fn imported_settlement_status(
        &self,
        id: &str,
    ) -> Result<ImportedSettlementStatus, TransportError> {
        let path = format!(
            "/admin/commerce/appointments/{}/imported-settlement",
            parse_id(id)?
        );
        let status: ImportedSettlementStatus =
            read_response(self.get(&self.agent, &path, None)?, false)?;
        if status.appointment_version <= 0 {
            return Err(TransportError::Server("Invalid settlement version".into()));
        }
        Ok(status)
    }

    pub fn confirm_imported_settlement(
        &self,
        id: &str,
        input: &ImportedSettlement,
    ) -> Result<u32, TransportError> {
        let path = format!(
            "/admin/commerce/appointments/{}/imported-settlement",
            parse_id(id)?
        );
        let status: ImportedSettlementStatus = self.put_json(&path, input)?;
        let settlement = status
            .settlement
            .filter(|row| {
                status.appointment_version > input.appointment_version
                    && row.amount_cents == input.amount_cents
            })
            .ok_or_else(|| TransportError::Server("Invalid settlement acknowledgement".into()))?;
        Ok(settlement.amount_cents)
    }

    pub fn imported_partial_payment_preview(
        &self,
        id: &str,
    ) -> Result<ImportedPartialPaymentPreview, TransportError> {
        let path = format!(
            "/admin/commerce/appointments/{}/imported-partial-payment",
            parse_id(id)?
        );
        read_response(self.get(&self.agent, &path, None)?, false)
    }

    pub fn confirm_imported_unpaid(
        &self,
        id: &str,
        appointment_version: i64,
        reference: &str,
    ) -> Result<(), TransportError> {
        let path = format!(
            "/admin/commerce/appointments/{}/imported-unpaid",
            parse_id(id)?
        );
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Response {
            appointment_version: i64,
        }
        let response: Response = self.put_json(
            &path,
            &serde_json::json!({ "appointmentVersion": appointment_version, "reference": reference }),
        )?;
        if response.appointment_version < appointment_version {
            return Err(TransportError::Server(
                "Invalid unpaid review acknowledgement".into(),
            ));
        }
        Ok(())
    }

    pub fn confirm_imported_partial_payment(
        &self,
        id: &str,
        input: &ImportedSettlement,
        original_total_cents: u32,
    ) -> Result<ExternalBalance, TransportError> {
        let path = format!(
            "/admin/commerce/appointments/{}/imported-partial-payment",
            parse_id(id)?
        );
        let result: ImportedPartialPayment = self.put_json(&path, input)?;
        let balance = result.external_balance;
        if result.appointment_version <= input.appointment_version
            || balance.paid_in_booksy_cents != input.amount_cents
            || balance.due_in_citame_cents == 0
            || balance
                .paid_in_booksy_cents
                .checked_add(balance.due_in_citame_cents)
                != Some(original_total_cents)
        {
            return Err(TransportError::Server(
                "Invalid partial payment acknowledgement".into(),
            ));
        }
        Ok(balance)
    }

    pub fn open_appointment_checkout(
        &self,
        appointment_id: &str,
        balance: Option<ExternalBalance>,
    ) -> Result<AppointmentCheckout, TransportError> {
        let id = parse_id(appointment_id)?;
        let mut input = serde_json::json!({
            "appointmentId": id.to_string(),
            "idempotencyKey": uuid::Uuid::now_v7().to_string(),
        });
        if balance.is_none() {
            input["useClientDiscount"] = serde_json::json!(true);
        }
        let receipt = self.post_json("/admin/commerce/checkouts", &input)?;
        validate_checkout(receipt, Some(id), balance)
    }

    pub fn browser_workspaces(&self) -> Result<Vec<BrowserWorkspace>, TransportError> {
        #[derive(serde::Deserialize)]
        struct Workspaces {
            workspaces: Vec<BrowserWorkspace>,
        }
        let response: Workspaces = read_response(
            self.get(&self.agent, "/me/desktop-workspaces", None)?,
            false,
        )?;
        Ok(response.workspaces)
    }

    pub fn checkout_history(
        &self,
        filters: &CheckoutHistoryFilters,
        page: u32,
    ) -> Result<CheckoutPage, TransportError> {
        if filters.search.trim().encode_utf16().count() > 150 || !(1..=100_000).contains(&page) {
            return Err(TransportError::BadRequest("Invalid receipt search".into()));
        }
        let mut query = url::form_urlencoded::Serializer::new(String::new());
        query
            .append_pair("search", filters.search.trim())
            .append_pair("page", &page.to_string())
            .append_pair("pageSize", "15");
        if let Some(client_id) = filters.client_id {
            query.append_pair("clientId", &client_id.to_string());
        }
        if let Some(status) = filters.status {
            query.append_pair("status", status);
        }
        if let Some(method) = filters.method {
            query.append_pair("method", method);
        }
        if let Some(from) = filters.from {
            query.append_pair("from", &from.to_rfc3339());
        }
        if let Some(to) = filters.to {
            query.append_pair("to", &to.to_rfc3339());
        }
        if let Some(group_by) = filters.group_by {
            query.append_pair("groupBy", group_by.as_str());
        }
        let query = query.finish();
        read_response(
            self.get(
                &self.agent,
                &format!("/admin/commerce/checkouts?{query}"),
                None,
            )?,
            false,
        )
    }

    pub fn open_saved_checkout(
        &self,
        id: uuid::Uuid,
    ) -> Result<AppointmentCheckout, TransportError> {
        let path = format!("/admin/commerce/checkouts/{id}");
        let receipt: AppointmentCheckout =
            read_response(self.get(&self.agent, &path, None)?, false)?;
        if parse_id(&receipt.id).ok() != Some(id) {
            return Err(TransportError::Server("Unexpected receipt identity".into()));
        }
        let appointment = receipt
            .appointment_id
            .as_deref()
            .map(parse_id)
            .transpose()?;
        let balance = receipt.external_balance;
        validate_checkout(receipt, appointment, balance)
    }

    pub fn can_assign_walk_in_sales(&self) -> Result<bool, TransportError> {
        #[derive(serde::Deserialize)]
        struct Permission {
            #[serde(rename = "allSales")]
            all_sales: bool,
        }
        #[derive(serde::Deserialize)]
        struct Capabilities {
            permissions: Permission,
        }
        let response: Capabilities = read_response(
            self.get(&self.agent, "/admin/commerce/capabilities", None)?,
            false,
        )?;
        Ok(response.permissions.all_sales)
    }

    pub fn create_walk_in_sale(
        &self,
        draft: &WalkInSale,
    ) -> Result<AppointmentCheckout, TransportError> {
        let receipt = self.post_json("/admin/commerce/checkouts", draft)?;
        validate_checkout(receipt, None, None)
    }

    pub fn finalize_checkout_prices(
        &self,
        checkout: &AppointmentCheckout,
        prices: &[CheckoutFinalPrice],
    ) -> Result<AppointmentCheckout, TransportError> {
        let version = checkout
            .pricing_version
            .filter(|_| checkout.can_review_prices());
        let next_version = version.and_then(|version| version.checked_add(1));
        let mut pending = checkout.lines.iter().filter(|line| line.price_pending);
        if next_version.is_none()
            || prices.len() != pending.clone().count()
            || prices.len() > 100
            || pending.any(|line| {
                prices
                    .iter()
                    .filter(|price| {
                        price.id == line.id
                            && (line.minimum_unit_amount_cents..=999_999_999)
                                .contains(&price.unit_amount_cents)
                    })
                    .count()
                    != 1
            })
        {
            return Err(TransportError::BadRequest(
                "Review all pending service prices".into(),
            ));
        }
        let id = parse_id(&checkout.id)?;
        let appointment = checkout
            .appointment_id
            .as_deref()
            .map(parse_id)
            .transpose()?;
        let receipt = self.put_json(
            &format!("/admin/commerce/checkouts/{id}/prices"),
            &serde_json::json!({ "version": version, "lines": prices }),
        )?;
        let receipt = validate_checkout(receipt, appointment, None)?;
        if parse_id(&receipt.id).ok() != Some(id)
            || receipt.pricing_version != next_version
            || receipt.lines.iter().any(|line| line.price_pending)
            || prices.iter().any(|price| {
                !receipt.lines.iter().any(|line| {
                    line.id == price.id && line.unit_amount_cents == price.unit_amount_cents
                })
            })
        {
            return Err(TransportError::Server(
                "Invalid final-price acknowledgement".into(),
            ));
        }
        Ok(receipt)
    }

    pub fn eligible_checkout_passes(
        &self,
        checkout: &AppointmentCheckout,
    ) -> Result<Vec<EligiblePassUse>, TransportError> {
        if !checkout.allows_pass() {
            return Ok(Vec::new());
        }
        #[derive(serde::Deserialize)]
        struct Period {
            id: uuid::Uuid,
        }
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Line {
            id: uuid::Uuid,
            description: String,
            amount_cents: u32,
        }
        #[derive(serde::Deserialize)]
        struct Pass {
            period: Period,
            name: String,
            kind: ReceiptTender,
            lines: Vec<Line>,
        }
        #[derive(serde::Deserialize)]
        struct Eligibility {
            eligible: Vec<Pass>,
        }
        let id = parse_id(&checkout.id)?;
        let response: Eligibility = read_response(
            self.get(
                &self.agent,
                &format!("/admin/passes/eligible?checkoutId={id}"),
                None,
            )?,
            false,
        )?;
        let limit = checkout.collectible_cents();
        Ok(response
            .eligible
            .into_iter()
            .filter(|pass| {
                matches!(
                    pass.kind,
                    ReceiptTender::Package | ReceiptTender::Membership
                )
            })
            .flat_map(|pass| {
                pass.lines.into_iter().filter_map(move |line| {
                    ((1..=limit).contains(&line.amount_cents)
                        && checkout
                            .lines
                            .iter()
                            .any(|candidate| candidate.id == line.id))
                    .then(|| EligiblePassUse {
                        period_id: pass.period.id,
                        line_id: line.id,
                        kind: pass.kind,
                        name: pass.name.clone(),
                        description: line.description,
                        amount_cents: line.amount_cents,
                    })
                })
            })
            .collect())
    }

    pub fn record_checkout_payment(
        &self,
        checkout: &AppointmentCheckout,
        attempt: &PaymentAttempt,
    ) -> Result<AppointmentCheckout, TransportError> {
        if attempt.amount_cents == 0 || attempt.amount_cents > checkout.collectible_cents() {
            return Err(TransportError::BadRequest(
                "The payment exceeds the collectible amount or this receipt cannot be paid".into(),
            ));
        }
        if attempt.method == ReceiptTender::GiftCard
            && (!checkout.allows_gift_card() || attempt.gift_card_code.is_none())
        {
            return Err(TransportError::BadRequest(
                "A valid gift card is required for this receipt".into(),
            ));
        }
        if matches!(
            attempt.method,
            ReceiptTender::Package | ReceiptTender::Membership
        ) && (!checkout.allows_pass()
            || !attempt
                .checkout_line_id
                .is_some_and(|line| checkout.lines.iter().any(|candidate| candidate.id == line)))
        {
            return Err(TransportError::BadRequest(
                "Choose an eligible pass and service".into(),
            ));
        }
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Payment {
            method: ReceiptTender,
            amount_cents: u32,
            status: String,
        }
        #[derive(serde::Deserialize)]
        struct Started {
            payment: Payment,
        }
        let id = parse_id(&checkout.id)?;
        checkout
            .appointment_id
            .as_deref()
            .map(parse_id)
            .transpose()?;
        let path = format!("/admin/commerce/checkouts/{id}");
        let result: Started = self.post_json(&format!("{path}/payments"), attempt)?;
        if result.payment.status != "succeeded"
            || result.payment.method != attempt.method
            || result.payment.amount_cents != attempt.amount_cents
        {
            return Err(TransportError::Server(
                "Invalid payment acknowledgement".into(),
            ));
        }
        self.refresh_checkout(checkout).map_err(|_| {
            TransportError::Server(
                "Payment recorded, but the receipt could not be refreshed".into(),
            )
        })
    }

    pub fn void_checkout(
        &self,
        checkout: &AppointmentCheckout,
    ) -> Result<AppointmentCheckout, TransportError> {
        if !checkout.can_void() {
            return Err(TransportError::BadRequest(
                "This receipt cannot be voided".into(),
            ));
        }
        let id = parse_id(&checkout.id)?;
        let appointment = checkout
            .appointment_id
            .as_deref()
            .map(parse_id)
            .transpose()?;
        let updated = self.post_json(
            &format!("/admin/commerce/checkouts/{id}/void"),
            &serde_json::json!({}),
        )?;
        let updated = validate_checkout(updated, appointment, checkout.external_balance)?;
        if parse_id(&updated.id).ok() != Some(id) || updated.status != "void" {
            return Err(TransportError::Server(
                "Invalid void acknowledgement".into(),
            ));
        }
        Ok(updated)
    }

    pub fn record_checkout_refund(
        &self,
        checkout: &AppointmentCheckout,
        payment_id: uuid::Uuid,
        attempt: &RefundAttempt,
    ) -> Result<AppointmentCheckout, TransportError> {
        let payment = checkout.recordable_refunds_available().find(|payment| {
            payment.id == payment_id && payment.covers_amount(attempt.amount_cents)
        });
        let Some(payment) = payment else {
            return Err(TransportError::BadRequest(
                "This payment cannot be refunded for the requested amount".into(),
            ));
        };
        match (&attempt.pass_quote, payment.pass_period_id) {
            (Some(selection), Some(period_id)) if selection.period_id == period_id => {}
            (None, None) => {}
            _ => {
                return Err(TransportError::BadRequest(
                    "A current quote is required for the selected pass".into(),
                ));
            }
        }
        let refund: CheckoutRefund = self.post_json(
            &format!("/admin/commerce/payments/{payment_id}/refunds"),
            attempt,
        )?;
        self.confirm_refund(
            checkout,
            refund,
            payment_id,
            attempt,
            matches!(payment.tender, RefundTender::Bank(_)),
        )
    }

    pub fn quote_pass_refund(
        &self,
        checkout: &AppointmentCheckout,
        payment_id: uuid::Uuid,
        unit_count: u32,
    ) -> Result<PassRefundQuote, TransportError> {
        let Some(period_id) = checkout
            .recordable_refunds_available()
            .find(|payment| payment.id == payment_id)
            .and_then(|payment| payment.pass_period_id)
            .filter(|_| unit_count <= PassRefundQuote::MAX_VISITS)
        else {
            return Err(TransportError::BadRequest(
                "Review the payment and unused visit count".into(),
            ));
        };
        let quote: PassRefundQuote = self.post_json(
            "/admin/passes/refund-quote",
            &serde_json::json!({
                "periodId": period_id,
                "paymentId": payment_id,
                "unitCount": unit_count,
            }),
        )?;
        if quote.unit_count != unit_count
            || quote.available_uses < unit_count
            || quote.excess_cents > quote.amount_cents
            || (quote.access_fee && unit_count > 0)
        {
            return Err(TransportError::Server("Invalid pass refund quote".into()));
        }
        Ok(quote)
    }

    pub fn record_reviewed_bank_refund(
        &self,
        checkout: &AppointmentCheckout,
        saved: &SavedBankRefund,
    ) -> Result<AppointmentCheckout, TransportError> {
        match saved.status(checkout) {
            SavedBankRefundStatus::Ready => {}
            SavedBankRefundStatus::Obsolete => {
                return Err(TransportError::ReplicaGenerationChanged);
            }
            SavedBankRefundStatus::Unavailable => {
                return Err(TransportError::Forbidden(
                    "The saved refund cannot be submitted from this receipt".into(),
                ));
            }
        }
        // A reservation may already have consumed the available amount. The server
        // matches the original key and payload before validating a new reservation.
        let refund: CheckoutRefund = self.post_json(
            &format!("/admin/commerce/payments/{}/refunds", saved.payment_id),
            &saved.request,
        )?;
        self.confirm_refund(
            checkout,
            refund,
            saved.payment_id,
            &saved.request.attempt,
            true,
        )
    }

    fn confirm_refund(
        &self,
        checkout: &AppointmentCheckout,
        refund: CheckoutRefund,
        payment_id: uuid::Uuid,
        attempt: &RefundAttempt,
        bank: bool,
    ) -> Result<AppointmentCheckout, TransportError> {
        let matches = |confirmed: &CheckoutRefund| {
            confirmed.payment_id == payment_id
                && confirmed.amount_cents == attempt.amount_cents
                && confirmed.reason == attempt.reason
                && (confirmed.status == "succeeded"
                    || bank
                        && matches!(
                            confirmed.status.as_str(),
                            "requested" | "dispatched" | "reconciliation" | "failed"
                        ))
        };
        if !matches(&refund) {
            return Err(TransportError::Server(
                "Invalid refund acknowledgement".into(),
            ));
        }
        let updated = self.refresh_checkout(checkout).map_err(|_| {
            TransportError::Server("Refund recorded, but the receipt could not be refreshed".into())
        })?;
        if !updated
            .refunds
            .iter()
            .any(|confirmed| confirmed.id == refund.id && matches(confirmed))
        {
            return Err(TransportError::Server(
                "Refund missing from refreshed receipt".into(),
            ));
        }
        Ok(updated)
    }

    pub fn dispatch_bank_refund(
        &self,
        checkout: &AppointmentCheckout,
        refund_id: uuid::Uuid,
    ) -> Result<AppointmentCheckout, TransportError> {
        self.update_bank_refund(checkout, refund_id, BankRefundOperation::Dispatch)
    }

    pub fn cancel_bank_refund(
        &self,
        checkout: &AppointmentCheckout,
        refund_id: uuid::Uuid,
    ) -> Result<AppointmentCheckout, TransportError> {
        self.update_bank_refund(checkout, refund_id, BankRefundOperation::Cancel)
    }

    pub fn reconcile_bank_refund(
        &self,
        checkout: &AppointmentCheckout,
        refund_id: uuid::Uuid,
        command: &BankPaymentReconciliation,
    ) -> Result<AppointmentCheckout, TransportError> {
        self.update_bank_refund(checkout, refund_id, BankRefundOperation::Reconcile(command))
    }

    fn update_bank_refund(
        &self,
        checkout: &AppointmentCheckout,
        refund_id: uuid::Uuid,
        operation: BankRefundOperation<'_>,
    ) -> Result<AppointmentCheckout, TransportError> {
        let (action, endpoint) = match operation {
            BankRefundOperation::Dispatch => (BankRefundAction::Dispatch, "execute"),
            BankRefundOperation::Cancel => (BankRefundAction::Cancel, "cancel"),
            BankRefundOperation::Reconcile(_) => (BankRefundAction::Reconcile, "reconcile"),
        };
        let Some(refund) = checkout
            .reviewable_bank_refunds(chrono::Utc::now())
            .find(|refund| refund.id == refund_id && refund.action == action)
        else {
            return Err(TransportError::BadRequest(
                "This bank refund is no longer eligible".into(),
            ));
        };
        let path = format!("/admin/commerce/refunds/{refund_id}/{endpoint}");
        let confirmed: CheckoutRefund = match operation {
            BankRefundOperation::Reconcile(review) => self.post_json(&path, review)?,
            _ => self.post_json(&path, &serde_json::json!({}))?,
        };
        let valid = |entry: &CheckoutRefund| {
            entry.id == refund_id
                && entry.payment_id == refund.payment_id
                && entry.amount_cents == refund.amount_cents
                && match operation {
                    BankRefundOperation::Reconcile(review) => {
                        entry.cancelled_at.is_none()
                            && matches!(entry.status.as_str(), "succeeded" | "failed")
                            && review.outcome.matches_status(&entry.status)
                    }
                    BankRefundOperation::Cancel => {
                        entry.status == "failed" && entry.cancelled_at.is_some()
                    }
                    BankRefundOperation::Dispatch => {
                        entry.cancelled_at.is_none()
                            && matches!(
                                entry.status.as_str(),
                                "dispatched" | "reconciliation" | "succeeded" | "failed"
                            )
                    }
                }
        };
        if !valid(&confirmed) {
            return Err(TransportError::Server(
                "Invalid bank refund acknowledgement".into(),
            ));
        }
        let updated = self.refresh_checkout(checkout)?;
        if !updated.refunds.iter().any(valid) {
            return Err(TransportError::Server(
                "Bank refund missing from refreshed receipt".into(),
            ));
        }
        Ok(updated)
    }

    pub fn refresh_checkout(
        &self,
        checkout: &AppointmentCheckout,
    ) -> Result<AppointmentCheckout, TransportError> {
        let id = parse_id(&checkout.id)?;
        let appointment = checkout
            .appointment_id
            .as_deref()
            .map(parse_id)
            .transpose()?;
        let path = format!("/admin/commerce/checkouts/{id}");
        let receipt: AppointmentCheckout =
            read_response(self.get(&self.agent, &path, None)?, false)?;
        if parse_id(&receipt.id).ok() != Some(id) {
            return Err(TransportError::Server(
                "Unexpected checkout confirmation".into(),
            ));
        }
        validate_checkout(receipt, appointment, checkout.external_balance)
    }

    pub fn reconcile_bank_payment(
        &self,
        checkout: &AppointmentCheckout,
        payment_id: uuid::Uuid,
        review: &BankPaymentReconciliation,
    ) -> Result<BankPaymentResolution, TransportError> {
        if !checkout
            .reconcilable_bank_payments(chrono::Utc::now())
            .any(|payment| payment.id == payment_id)
        {
            return Err(TransportError::BadRequest(
                "This bank payment is not eligible for reconciliation".into(),
            ));
        }
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Acknowledgement {
            id: uuid::Uuid,
            checkout_id: uuid::Uuid,
            status: String,
        }
        let checkout_id = parse_id(&checkout.id)?;
        let path = format!("/admin/commerce/payments/{payment_id}/reconcile");
        let result: Result<Acknowledgement, _> = self.post_json(&path, review);
        match result {
            Ok(confirmed)
                if confirmed.id == payment_id
                    && confirmed.checkout_id == checkout_id
                    && review.outcome.matches_status(&confirmed.status) => {}
            Ok(_) => {
                return Err(TransportError::Server(
                    "Invalid reconciliation acknowledgement".into(),
                ));
            }
            Err(error) => return Err(error),
        }
        let updated = self.refresh_checkout(checkout)?;
        if let Some(status @ ("succeeded" | "failed" | "reconciliation")) =
            updated.bank_payment_status(payment_id)
        {
            let bank_outcome_changed = !review.outcome.matches_status(status);
            return Ok(BankPaymentResolution {
                receipt: updated,
                bank_outcome_changed,
            });
        }
        Err(TransportError::Server(
            "Reconciled payment missing from refreshed receipt".into(),
        ))
    }

    pub fn current_cash_session(&self) -> Result<Option<CashSession>, TransportError> {
        #[derive(serde::Deserialize)]
        struct Current {
            session: Option<CashSession>,
        }
        let path = "/admin/commerce/cash-sessions/current";
        let current: Current = read_response(self.get(&self.agent, path, None)?, false)?;
        Ok(current.session)
    }

    pub fn update_cash_session(
        &self,
        command: &CashCommand,
    ) -> Result<CashSession, TransportError> {
        use serde_json::json;

        let base = "/admin/commerce/cash-sessions";
        let (id, path, body) = match command {
            CashCommand::Open { id, opening_cents } => (
                id,
                base.to_owned(),
                json!({ "sessionId": id, "openingCents": opening_cents }),
            ),
            CashCommand::Close {
                id,
                counted_cents,
                reviewed_expected_cents,
            } => (
                id,
                format!("{base}/{id}/close"),
                json!({
                    "countedCents": counted_cents, "reviewedExpectedCents": reviewed_expected_cents,
                }),
            ),
            CashCommand::Adjust {
                id,
                kind,
                amount_cents,
                reason,
                request_key,
            } => (
                id,
                format!("{base}/adjust"),
                json!({
                    "sessionId": id, "kind": kind, "amountCents": amount_cents,
                    "reason": reason, "idempotencyKey": request_key,
                }),
            ),
        };
        let result: CashSession = self.post_json(&path, &body)?;
        if result.id != *id {
            return Err(TransportError::Server(
                "Unexpected cash register acknowledgement".into(),
            ));
        }
        Ok(result)
    }

    fn put_json<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        input: &impl serde::Serialize,
    ) -> Result<T, TransportError> {
        read_response(self.send_put_json(path, input)?, false)
    }

    fn send_put_json(
        &self,
        path: &str,
        input: &impl serde::Serialize,
    ) -> Result<ureq::http::Response<ureq::Body>, TransportError> {
        let mut request = self.agent.put(&format!("{}{path}", self.base_url));
        for (name, value) in self.headers()? {
            request = request.header(name, value);
        }
        let body = serde_json::to_string(input)
            .map_err(|error| TransportError::BadRequest(error.to_string()))?;
        request
            .content_type("application/json")
            .send(body)
            .map_err(|error| TransportError::Offline(error.to_string()))
    }

    fn get(
        &self,
        agent: &ureq::Agent,
        path: &str,
        accept: Option<&str>,
    ) -> Result<ureq::http::Response<ureq::Body>, TransportError> {
        let mut req = agent.get(&format!("{}{path}", self.base_url));
        for (k, v) in self.headers()? {
            req = req.header(k, v);
        }
        if let Some(a) = accept {
            req = req.header("Accept", a);
        }
        req.call()
            .map_err(|e| TransportError::Offline(e.to_string()))
    }

    pub fn calendar_inbox(
        &self,
        archived: bool,
        page: u32,
    ) -> Result<CalendarInbox, TransportError> {
        let response = self.get(
            &self.agent,
            &format!("/admin/notifications/inbox?archived={archived}&page={page}"),
            Some("application/json"),
        )?;
        read_response(response, false)
    }

    pub fn unpaid_appointments(
        &self,
        date: chrono::NaiveDate,
        timezone: chrono_tz::Tz,
    ) -> Result<crate::billing::UnpaidAppointments, TransportError> {
        let (from, to) = crate::calendar::local_day_range(timezone, date);
        if from >= to {
            return Err(TransportError::BadRequest(
                "Choose a valid local day".into(),
            ));
        }
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("from", &from.to_rfc3339())
            .append_pair("to", &to.to_rfc3339())
            .append_pair("booksyPaymentReview", "1")
            .finish();
        let response = self.get(
            &self.agent,
            &format!("/admin/commerce/unpaid?{query}"),
            None,
        )?;
        let appointments: crate::billing::UnpaidAppointments = read_response(response, false)?;
        if !appointments.valid() {
            return Err(TransportError::Server(
                "Unexpected unpaid appointments response".into(),
            ));
        }
        Ok(appointments)
    }

    pub fn report_summary(&self, query: &ReportQuery) -> Result<ReportSummary, TransportError> {
        read_response(
            self.get(&self.agent, &query.path(), Some("application/json"))?,
            false,
        )
    }

    pub fn review_requests(
        &self,
        page: u32,
        search: &str,
    ) -> Result<ReviewRequests, TransportError> {
        read_response(
            self.get(
                &self.agent,
                &reviews::requests_path(page, search),
                Some("application/json"),
            )?,
            false,
        )
    }

    pub fn request_review_email(
        &self,
        appointment_id: &str,
    ) -> Result<EmailStatus, TransportError> {
        let result: ReviewEmail = self.post_json(
            &format!(
                "/admin/reviews/requests/{}/email",
                parse_id(appointment_id)?
            ),
            &serde_json::json!({}),
        )?;
        Ok(result.status)
    }

    pub fn inventory_products(
        &self,
        query: &ProductQuery,
        page: u32,
    ) -> Result<ProductPage, TransportError> {
        self.load_inventory_page(&query.path(page), page)
    }

    pub fn products_for_sale(
        &self,
        query: &ProductQuery,
        page: u32,
    ) -> Result<ProductPage, TransportError> {
        self.inventory_products(
            &ProductQuery {
                resellable: Some(true),
                ..query.clone()
            },
            page,
        )
    }

    pub fn inventory_facets(&self) -> Result<InventoryFacets, TransportError> {
        read_response(
            self.get(&self.agent, "/admin/inventory/facets", None)?,
            false,
        )
    }

    pub fn inventory_report(
        &self,
        query: &ProductQuery,
    ) -> Result<InventoryReport, TransportError> {
        read_response(self.get(&self.agent, &query.report_path(), None)?, false)
    }

    pub fn write_inventory_products_csv(
        &self,
        query: &ProductQuery,
        output: &mut impl std::io::Write,
    ) -> Result<(), TransportError> {
        self.write_csv(&query.export_path(), output)
    }

    fn load_inventory_page(&self, path: &str, page: u32) -> Result<ProductPage, TransportError> {
        let response: ProductPage = read_response(self.get(&self.agent, path, None)?, false)?;
        if response.pagination.page != page || response.pagination.page_size == 0 {
            return Err(TransportError::Server("Unexpected inventory page".into()));
        }
        Ok(response)
    }

    pub fn inventory_product(&self, id: uuid::Uuid) -> Result<Product, TransportError> {
        self.lookup_inventory_product(id)?
            .ok_or_else(|| TransportError::BadRequest("Product not found".into()))
    }

    pub fn inventory_product_photo(
        &self,
        id: ProductId,
        version: uuid::Uuid,
    ) -> Result<Vec<u8>, TransportError> {
        self.read_private_jpeg(&format!("{PRODUCTS_PATH}/{id}/photo/{version}"))
    }

    fn read_private_jpeg(&self, path: &str) -> Result<Vec<u8>, TransportError> {
        use std::io::Read;
        const LIMIT: u64 = 256 * 1024;
        let mut response = self.get(&self.agent, path, Some("image/jpeg"))?;
        let status = response.status().as_u16();
        if status != 200 {
            return Err(classify_status(
                status,
                None,
                "Private image unavailable",
                false,
            ));
        }
        if response
            .headers()
            .get("content-type")
            .is_none_or(|mime| mime != "image/jpeg")
        {
            return Err(TransportError::Server(
                "Unexpected private image format".into(),
            ));
        }
        let mut bytes = Vec::new();
        response
            .body_mut()
            .as_reader()
            .take(LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| TransportError::Offline(error.to_string()))?;
        if bytes.len() as u64 > LIMIT || !crate::staff_portrait_image::is_bounded_jpeg(&bytes) {
            return Err(TransportError::Server("Invalid private JPEG".into()));
        }
        Ok(bytes)
    }

    pub fn lookup_inventory_product(
        &self,
        id: ProductId,
    ) -> Result<Option<Product>, TransportError> {
        let response = self.get(&self.agent, &format!("{PRODUCTS_PATH}/{id}"), None)?;
        if response.status() == ureq::http::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let product: Product = read_response(response, false)?;
        if product.id != id {
            return Err(TransportError::Server(
                "Unexpected inventory product".into(),
            ));
        }
        Ok(Some(product))
    }

    pub fn inventory_classifications(
        &self,
    ) -> Result<crate::inventory_classifications::ClassificationCatalogue, TransportError> {
        read_response(
            self.get(&self.agent, "/admin/inventory/classifications", None)?,
            false,
        )
    }

    pub fn inventory_ledger(
        &self,
        query: &LedgerQuery,
        page: u32,
    ) -> Result<LedgerPage, TransportError> {
        let result: LedgerPage =
            read_response(self.get(&self.agent, &query.list_path(page), None)?, false)?;
        if result.pagination.page != page
            || result.pagination.page_size == 0
            || (query.anchor.is_some() && result.anchor != query.anchor)
            || result
                .movements
                .iter()
                .any(|row| !query.includes(&row.movement))
        {
            return Err(TransportError::Server(
                "Unexpected stock ledger page".into(),
            ));
        }
        Ok(result)
    }

    pub fn write_inventory_ledger_csv(
        &self,
        query: &LedgerQuery,
        output: &mut impl std::io::Write,
    ) -> Result<(), TransportError> {
        self.write_csv(&query.export_path(), output)
    }

    pub fn inventory_movements(
        &self,
        id: ProductId,
        page: u32,
    ) -> Result<MovementPage, TransportError> {
        let response: MovementPage = read_response(
            self.get(
                &self.agent,
                &format!("{PRODUCTS_PATH}/{id}/movements?page={page}"),
                None,
            )?,
            false,
        )?;
        if response.pagination.page != page
            || response.pagination.page_size == 0
            || response
                .movements
                .iter()
                .any(|movement| movement.product_id != id)
        {
            return Err(TransportError::Server(
                "Unexpected inventory movements".into(),
            ));
        }
        Ok(response)
    }

    pub fn return_inventory_stock(
        &self,
        attempt: &StockReturnAttempt,
    ) -> Result<Product, TransportError> {
        let product: Product = self.post_json("/admin/inventory/returns", &attempt.command)?;
        if product.id != attempt.product_id {
            return Err(TransportError::Server("Unexpected returned product".into()));
        }
        Ok(product)
    }

    pub fn move_inventory_stock(&self, pending: &PendingStock) -> Result<Product, StockWriteError> {
        let id = pending.product_id;
        let response =
            self.send_json(&format!("{PRODUCTS_PATH}/{id}/movements"), &pending.command)?;
        let product: Product = read_response_with(response, |status, retry_after, body| {
            let value = serde_json::from_str::<serde_json::Value>(body).ok();
            let code = value
                .as_ref()
                .and_then(|value| value.pointer("/error/code"))
                .and_then(serde_json::Value::as_str);
            match (status, code) {
                (409, Some("version_conflict")) => StockWriteError::Conflict,
                (409, Some("invalid_state")) => StockWriteError::Rejected,
                _ => classify_status(status, retry_after, body, false).into(),
            }
        })?;
        if product.id != id
            || product.version <= pending.command.version
            || product.inventory_generation.as_deref() != Some(&pending.command.generation)
        {
            return Err(
                TransportError::Server("Unexpected inventory stock response".into()).into(),
            );
        }
        Ok(product)
    }

    pub fn update_inventory_content(
        &self,
        id: uuid::Uuid,
        version: u32,
        package_content: Option<&PackageContent>,
    ) -> Result<Product, ContentWriteError> {
        let mut request = self.agent.patch(&format!(
            "{}{PRODUCTS_PATH}/{id}/package-content",
            self.base_url
        ));
        for (name, value) in self.headers()? {
            request = request.header(name, value);
        }
        let response = request
            .content_type("application/json")
            .send(
                serde_json::json!({ "version": version, "packageContent": package_content })
                    .to_string(),
            )
            .map_err(|err| TransportError::Offline(err.to_string()))?;
        if response.status().as_u16() == 409 {
            return Err(ContentWriteError::Conflict);
        }
        let updated: Product = read_response(response, false)?;
        if updated.id != id
            || updated.version <= version
            || updated.package_content.as_ref() != package_content
        {
            return Err(TransportError::Server("Unexpected inventory update".into()).into());
        }
        Ok(updated)
    }

    pub fn intake_forms(&self) -> Result<Vec<AdminFormSummary>, TransportError> {
        let data: AdminForms = read_response(
            self.get(
                &self.agent,
                "/admin/intake-forms?view=summary",
                Some("application/json"),
            )?,
            false,
        )?;
        Ok(data.forms)
    }

    pub fn intake_form(&self, id: &str) -> Result<AdminForm, TransportError> {
        let form: AdminForm = read_response_with(
            self.get(
                &self.agent,
                &format!("/admin/intake-forms/{}", parse_id(id)?),
                Some("application/json"),
            )?,
            review_transport_error,
        )?;
        if form.id != id {
            return Err(TransportError::Server("Unexpected form detail".into()));
        }
        Ok(form)
    }

    pub fn write_intake_form(
        &self,
        action: &FormWrite,
        retry_base: Option<&AdminForm>,
    ) -> Result<AdminForm, FormWriteError> {
        match self.send_intake_form(action) {
            Err(FormWriteError::Conflict) if let Some(base) = retry_base => {
                recovered_form(action, base, self.intake_form(&base.id)?)
                    .ok_or(FormWriteError::Conflict)
            }
            result => result,
        }
    }

    fn send_intake_form(&self, action: &FormWrite) -> Result<AdminForm, FormWriteError> {
        let response = match action {
            FormWrite::Create { key, definition } => self.send_json(
                "/admin/intake-forms",
                &serde_json::json!({ "idempotencyKey": parse_id(key)?, "definition": definition }),
            ),
            FormWrite::Save {
                id,
                version,
                definition,
            } => self.send_put_json(
                &format!("/admin/intake-forms/{}", parse_id(id)?),
                &serde_json::json!({ "version": version, "definition": definition }),
            ),
            FormWrite::Publish { id, version } | FormWrite::Archive { id, version } => {
                let operation = if matches!(action, FormWrite::Publish { .. }) {
                    "publish"
                } else {
                    "archive"
                };
                self.send_json(
                    &format!("/admin/intake-forms/{}/{operation}", parse_id(id)?),
                    &serde_json::json!({ "version": version }),
                )
            }
        }?;
        let form: AdminForm = read_response_with(response, intake_write_error)?;
        let expected = match action {
            FormWrite::Create { .. } => None,
            FormWrite::Save { id, .. }
            | FormWrite::Publish { id, .. }
            | FormWrite::Archive { id, .. } => Some(id),
        };
        if expected.is_some_and(|id| *id != form.id) {
            return Err(TransportError::Server("Unexpected form acknowledgement".into()).into());
        }
        Ok(form)
    }

    pub fn managed_reviews(
        &self,
        status: Option<ReviewStatus>,
        before: Option<&str>,
    ) -> Result<ReviewPage, TransportError> {
        read_response(
            self.get(
                &self.agent,
                &reviews::moderation_path(status, before),
                Some("application/json"),
            )?,
            false,
        )
    }

    pub fn update_managed_review(
        &self,
        id: &str,
        version: u32,
        command: ModerationCommand<'_>,
    ) -> Result<ManagedReview, TransportError> {
        let (operation, payload) = command.payload(version);
        self.put_json(
            &format!("/admin/reviews/{}/{operation}", parse_id(id)?),
            &payload,
        )
    }

    pub fn report_clients(&self, query: &ReportQuery) -> Result<ClientReport, TransportError> {
        read_response(
            self.get(&self.agent, &query.clients_path(), Some("application/json"))?,
            false,
        )
    }

    pub fn financial_report(&self, query: &ReportQuery) -> Result<FinancialReport, TransportError> {
        read_response(
            self.get(
                &self.agent,
                &query.financial_path(),
                Some("application/json"),
            )?,
            false,
        )
    }

    pub fn commission_scope(&self) -> Result<CommissionScope, TransportError> {
        read_response(
            self.get(
                &self.agent,
                "/admin/accounting/statement-scope",
                Some("application/json"),
            )?,
            false,
        )
    }

    pub fn commission_statement(
        &self,
        staff_id: &str,
        page: u32,
        payout_page: u32,
    ) -> Result<CommissionStatement, TransportError> {
        let staff_id = parse_id(staff_id)?;
        let path = format!(
            "/admin/accounting/staff/{staff_id}/statement?page={page}&payoutPage={payout_page}"
        );
        read_response(
            self.get(&self.agent, &path, Some("application/json"))?,
            false,
        )
    }

    pub fn reviewed_commission_policy(
        &self,
        staff_id: uuid::Uuid,
    ) -> Result<CommissionPolicy, TransportError> {
        let path = format!("/admin/accounting/staff/{staff_id}/policy/reviewed");
        read_response(
            self.get(&self.agent, &path, Some("application/json"))?,
            false,
        )
    }

    pub fn set_reviewed_commission_rates(
        &self,
        staff_id: uuid::Uuid,
        rates: &CommissionRateEdit,
    ) -> Result<CommissionPolicy, TransportError> {
        let saved: CommissionPolicy = self.put_json(
            &format!("/admin/accounting/staff/{staff_id}/policy/reviewed"),
            rates,
        )?;
        if saved.staff_id.parse::<uuid::Uuid>().ok() != Some(staff_id)
            || saved.generation != rates.generation
            || saved.service_basis_points != rates.service_basis_points
            || saved.product_basis_points != rates.product_basis_points
        {
            return Err(TransportError::Server(
                "Unverified commission policy response".into(),
            ));
        }
        Ok(saved)
    }

    pub fn record_reviewed_commission_payout(
        &self,
        payout: &SavedCommissionPayout,
        reconciliation: Option<(&str, uuid::Uuid)>,
    ) -> Result<RecordedCommissionPayout, CommissionPayoutError> {
        #[derive(serde::Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Input {
            #[serde(flatten)]
            review: crate::reports::commissions::CommissionPayoutReview,
            #[serde(skip_serializing_if = "Option::is_none")]
            existing_payout_id: Option<uuid::Uuid>,
        }
        let mut review = payout.review.clone();
        if let Some((generation, _)) = reconciliation {
            review.generation = generation.to_owned();
        }
        let input = Input {
            review,
            existing_payout_id: reconciliation.map(|(_, id)| id),
        };
        let path = format!(
            "/admin/accounting/staff/{}/payouts/reviewed",
            payout.staff_id
        );
        let response = self.send_json(&path, &input)?;
        let recorded: RecordedCommissionPayout =
            read_response_with(response, |status, retry_after, body| {
                let error = serde_json::from_str::<serde_json::Value>(body).ok();
                let code = error
                    .as_ref()
                    .and_then(|value| value.pointer("/error/code"))
                    .and_then(serde_json::Value::as_str);
                match (status, code) {
                    (409, Some("invalid_state")) => CommissionPayoutError::BalanceChanged,
                    (409, Some("version_conflict")) => CommissionPayoutError::KeyConflict,
                    (404, Some("not_found")) if reconciliation.is_some() => {
                        CommissionPayoutError::NoMatch
                    }
                    (400, Some("validation_error")) => CommissionPayoutError::InvalidReview,
                    _ => review_transport_error(status, retry_after, body).into(),
                }
            })?;
        if recorded.staff_id != payout.staff_id
            || reconciliation.is_some_and(|(_, id)| recorded.id != id)
            || recorded.idempotency_key != payout.review.idempotency_key
            || recorded.amount_cents != payout.review.amount_cents
            || recorded.reference != crate::trim_like_javascript(&payout.review.reference)
        {
            return Err(
                TransportError::Server("Unverified commission payout response".into()).into(),
            );
        }
        Ok(recorded)
    }

    pub fn report_outcomes(
        &self,
        query: &ReportQuery,
        status: Outcome,
        page: u32,
    ) -> Result<OutcomePage, TransportError> {
        read_response(
            self.get(
                &self.agent,
                &query.outcome_path(status, page),
                Some("application/json"),
            )?,
            false,
        )
    }

    pub fn write_report_outcomes_csv(
        &self,
        query: &ReportQuery,
        status: Outcome,
        output: &mut impl std::io::Write,
    ) -> Result<(), TransportError> {
        self.write_csv(&query.outcome_export_path(status), output)
    }

    fn write_csv(
        &self,
        path: &str,
        output: &mut impl std::io::Write,
    ) -> Result<(), TransportError> {
        let mut response = self.get(&self.agent, path, Some("text/csv"))?;
        let code = response.status().as_u16();
        if code != 200 {
            let retry_after = response
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok());
            return Err(classify_status(code, retry_after, "", false));
        }
        if !response.headers().get("content-type").is_some_and(|value| {
            value
                .to_str()
                .is_ok_and(|mime| mime.split(';').next() == Some("text/csv"))
        }) {
            return Err(TransportError::Server("Expected a CSV download".into()));
        }
        std::io::copy(&mut response.body_mut().as_reader(), output)
            .map_err(|error| TransportError::Offline(error.to_string()))?;
        Ok(())
    }

    pub fn set_calendar_notice_archived(
        &self,
        id: &str,
        archived: bool,
    ) -> Result<(), TransportError> {
        let body = serde_json::json!({ "ids": [id], "archived": archived }).to_string();
        let mut request = self.agent.post(&format!(
            "{}/admin/notifications/inbox/archive",
            self.base_url
        ));
        for (key, value) in self.headers()? {
            request = request.header(key, value);
        }
        let response = request
            .content_type("application/json")
            .send(body)
            .map_err(|e| TransportError::Offline(e.to_string()))?;
        let result: serde_json::Value = read_response(response, false)?;
        if result.get("ok") != Some(&serde_json::Value::Bool(true)) {
            return Err(TransportError::Server(
                "Invalid calendar inbox response".into(),
            ));
        }
        Ok(())
    }
    pub fn waitlist(&self, page: u32, active: bool) -> Result<WaitlistPage, TransportError> {
        let response = self.get(
            &self.agent,
            &format!("/admin/waitlist/desk?page={page}&pageSize=15&active={active}"),
            None,
        )?;
        read_response(response, false)
    }

    pub fn join_waitlist(&self, input: &WaitlistRequest) -> Result<WaitlistEntry, TransportError> {
        self.post_json("/admin/waitlist/desk", input)
    }

    pub fn cancel_waitlist(&self, id: &str, version: u32) -> Result<WaitlistEntry, TransportError> {
        self.post_json(
            &format!("/admin/waitlist/desk/{}/cancel", parse_id(id)?),
            &serde_json::json!({ "version": version }),
        )
    }

    pub fn update_waitlist_policy(
        &self,
        policy: &WaitlistPolicy,
    ) -> Result<WaitlistPolicy, TransportError> {
        let mut request = self
            .agent
            .put(&format!("{}/admin/waitlist/desk/policy", self.base_url));
        for (key, value) in self.headers()? {
            request = request.header(key, value);
        }
        let body =
            serde_json::to_string(policy).map_err(|e| TransportError::BadRequest(e.to_string()))?;
        read_response(
            request
                .content_type("application/json")
                .send(body)
                .map_err(|e| TransportError::Offline(e.to_string()))?,
            false,
        )
    }

    pub fn booking_policy(&self) -> Result<ReviewedBookingPolicy, TransportError> {
        read_response(
            self.get(&self.agent, "/admin/settings/booking-policy/reviewed", None)?,
            false,
        )
    }

    pub fn write_booking_policy(
        &self,
        reviewed: &ReviewedBookingPolicy,
    ) -> Result<ReviewedBookingPolicy, PolicyWriteError> {
        let response = self.send_put_json("/admin/settings/booking-policy/reviewed", reviewed)?;
        read_response_with(response, |status, retry_after, body| {
            let parsed = serde_json::from_str::<serde_json::Value>(body).ok();
            let code = parsed
                .as_ref()
                .and_then(|value| value.pointer("/error/code"))
                .and_then(serde_json::Value::as_str);
            match (status, code) {
                (409, Some("version_conflict" | "sync_generation_changed")) => {
                    PolicyWriteError::Conflict
                }
                (409, Some("invalid_state")) => PolicyWriteError::MixedCurrencies,
                _ => classify_status(status, retry_after, body, false).into(),
            }
        })
    }

    pub fn accept_waitlist_offer(
        &self,
        id: &str,
        input: &AcceptOffer,
    ) -> Result<AcceptedOffer, AcceptOfferError> {
        let response = self.send_json(
            &format!("/admin/waitlist/desk/{}/accept", parse_id(id)?),
            input,
        )?;
        read_response_with(response, |status, retry_after, body| {
            let error = serde_json::from_str::<serde_json::Value>(body).ok();
            let code = error
                .as_ref()
                .and_then(|value| value.pointer("/error/code"))
                .and_then(serde_json::Value::as_str);
            match (status, code) {
                (409, Some("intake_required")) => AcceptOfferError::IntakeChanged,
                (409, Some("storage_limit")) => AcceptOfferError::ResponseLimit,
                (400, Some("validation_error"))
                | (
                    409,
                    Some(
                        "invalid_state"
                        | "version_conflict"
                        | "slot_unavailable"
                        | "slot_taken"
                        | "client_merged"
                        | "online_booking_paused",
                    ),
                ) => AcceptOfferError::Rejected,
                _ => classify_status(status, retry_after, body, false).into(),
            }
        })
    }

    pub fn requeue_waitlist_offer(
        &self,
        id: &str,
        version: u32,
        offer: &str,
    ) -> Result<WaitlistEntry, TransportError> {
        self.post_json(
            &format!("/admin/waitlist/desk/{}/decline", parse_id(id)?),
            &serde_json::json!({ "version": version, "offerId": offer, "requeue": true }),
        )
    }

    pub fn waitlist_offer_requirements(
        &self,
        entry: &WaitlistEntry,
    ) -> Result<(IntakeRequirements, bool), TransportError> {
        let requirements =
            self.intake_booking_requirements(&entry.service_ids, Some(&entry.client_id))?;
        Ok((requirements, self.can_waive_deposit()?))
    }

    pub fn can_waive_deposit(&self) -> Result<bool, TransportError> {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Viewer {
            user: UserRole,
            access_preset: Option<String>,
        }
        #[derive(serde::Deserialize)]
        struct UserRole {
            role: String,
        }
        let viewer: Viewer = read_response(self.get(&self.agent, "/me", None)?, false)?;
        Ok(viewer.user.role == "owner" || viewer.access_preset.as_deref() == Some("manager"))
    }

    pub fn direct_booking_requirements(
        &self,
        terms: &BookingTerms,
    ) -> Result<IntakeRequirements, TransportError> {
        self.intake_booking_requirements(terms.service_ids(), terms.client_id())
    }

    fn intake_booking_requirements(
        &self,
        service_ids: &[String],
        client_id: Option<&str>,
    ) -> Result<IntakeRequirements, TransportError> {
        let services = service_ids
            .iter()
            .map(|id| parse_id(id).map(|id| id.to_string()))
            .collect::<Result<Vec<_>, _>>()?
            .join(",");
        let mut path = format!("/intake/requirements?serviceIds={services}");
        if let Some(id) = client_id {
            use std::fmt::Write as _;
            let _ = write!(path, "&clientId={}", parse_id(id)?);
        }
        read_response(self.get(&self.agent, &path, None)?, false)
    }

    pub fn create_reviewed_booking(
        &self,
        booking: &ReviewedBooking,
    ) -> Result<BookedAppointment, BookingError> {
        let response = self.send_json("/appointments/desktop-booking", booking)?;
        let result: BookedAppointment = read_response_with(response, classify_booking_error)?;
        if !booking.matches(&result.id, result.starts_at) {
            return Err(TransportError::Server("Unexpected booking acknowledgement".into()).into());
        }
        Ok(result)
    }

    pub fn create_booking_attempt(
        &self,
        attempt: &BookingAttempt,
    ) -> Result<BookingConfirmation, BookingError> {
        match attempt {
            BookingAttempt::Single(packet) => self
                .create_reviewed_booking(packet)
                .map(|saved| BookingConfirmation::Booked(saved.starts_at)),
            BookingAttempt::Series(packet) => self.create_reviewed_series(packet),
        }
    }

    pub fn preview_booking_series(
        &self,
        packet: &SeriesPacket,
    ) -> Result<SeriesPreview, BookingError> {
        let response = self.send_json("/appointments/desktop-series/preview", packet)?;
        let preview: SeriesPreview = read_response_with(response, classify_booking_error)?;
        if preview.occurrences.len() != packet.count()
            || preview.timezone.parse::<chrono_tz::Tz>().is_err()
        {
            return Err(TransportError::Server("Unexpected series preview".into()).into());
        }
        Ok(preview)
    }

    pub fn create_reviewed_series(
        &self,
        packet: &ReviewedSeries,
    ) -> Result<BookingConfirmation, BookingError> {
        #[derive(serde::Deserialize)]
        struct Series {
            #[serde(rename = "id")]
            _id: uuid::Uuid,
            appointments: Vec<BookedAppointment>,
        }
        let response = self.send_json("/appointments/desktop-series", packet)?;
        let series: Series = read_response_with(response, classify_booking_error)?;
        packet.confirm(&series.appointments)
    }

    pub fn preview_visit(&self, packet: &VisitPacket) -> Result<VisitPreview, BookingError> {
        let response = self.send_json("/appointments/desktop-visits/preview", packet)?;
        let preview: VisitPreview = read_response_with(response, classify_booking_error)?;
        if !packet.matches_preview(&preview) {
            return Err(TransportError::Server("Unexpected visit preview".into()).into());
        }
        Ok(preview)
    }

    pub fn create_reviewed_visit(
        &self,
        packet: &ReviewedVisit,
    ) -> Result<VisitConfirmation, BookingError> {
        #[derive(serde::Deserialize)]
        struct Visit {
            id: String,
            appointments: Vec<Appointment>,
        }
        let response = self.send_json("/appointments/desktop-visits", packet)?;
        let visit: Visit = read_response_with(response, classify_booking_error)?;
        packet.acknowledge(&visit.id, &visit.appointments)
    }

    fn post_json<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        input: &impl serde::Serialize,
    ) -> Result<T, TransportError> {
        read_response(self.send_json(path, input)?, false)
    }

    fn send_json(
        &self,
        path: &str,
        input: &impl serde::Serialize,
    ) -> Result<ureq::http::Response<ureq::Body>, TransportError> {
        let body =
            serde_json::to_string(input).map_err(|e| TransportError::BadRequest(e.to_string()))?;
        let mut request = self.agent.post(&format!("{}{path}", self.base_url));
        for (key, value) in self.headers()? {
            request = request.header(key, value);
        }
        request
            .content_type("application/json")
            .send(body)
            .map_err(|e| TransportError::Offline(e.to_string()))
    }
}

fn validate_checkout(
    receipt: AppointmentCheckout,
    appointment: Option<uuid::Uuid>,
    balance: Option<ExternalBalance>,
) -> Result<AppointmentCheckout, TransportError> {
    if receipt
        .appointment_id
        .as_deref()
        .map(uuid::Uuid::parse_str)
        .transpose()
        .ok()
        != Some(appointment)
        || parse_id(&receipt.id).is_err()
        || receipt.currency != "EUR"
        || receipt.external_balance != balance
        || balance.is_some_and(|balance| receipt.total_cents != balance.due_in_citame_cents)
        || i64::try_from(receipt.paid_cents).is_err()
        || receipt.balance_cents > receipt.total_cents
        || receipt
            .payable_cents
            .is_some_and(|payable| payable > receipt.balance_cents)
    {
        return Err(TransportError::Server(
            "The receipt changed or contains invalid totals".into(),
        ));
    }
    Ok(receipt)
}

fn parse_id(id: &str) -> Result<uuid::Uuid, TransportError> {
    uuid::Uuid::parse_str(id)
        .map_err(|_| TransportError::BadRequest("Invalid resource identity".into()))
}

fn error_message(body: &str) -> String {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| {
            v.pointer("/error/message")
                .and_then(|m| m.as_str().map(str::to_owned))
        })
        .unwrap_or_else(|| body.chars().take(200).collect())
}

/// Maps an error response to the protocol's error table.
fn classify_booking_error(status: u16, retry_after: Option<&str>, body: &str) -> BookingError {
    let error = serde_json::from_str::<serde_json::Value>(body).ok();
    let code = error
        .as_ref()
        .and_then(|err| err.pointer("/error/code"))
        .and_then(serde_json::Value::as_str);
    match (status, code) {
        (409, Some("intake_required")) => BookingError::IntakeChanged,
        (409, Some("slot_taken" | "slot_unavailable")) => BookingError::SlotUnavailable,
        (409, Some("version_conflict")) => BookingError::CatalogueChanged,
        (409, Some("booking_intent_conflict")) => BookingError::IntentConflict,
        (401, Some("unauthorized")) | (403, Some("forbidden")) | (404, Some("not_found")) => {
            BookingError::AccessChanged
        }
        (400, Some("validation_error"))
        | (409, Some("invalid_state" | "client_merged" | "storage_limit")) => {
            BookingError::Rejected
        }
        _ => classify_status(status, retry_after, body, false).into(),
    }
}

pub fn classify_status(
    status: u16,
    retry_after: Option<&str>,
    body: &str,
    is_pull: bool,
) -> TransportError {
    match status {
        401 => TransportError::Unauthorized,
        403 => TransportError::Forbidden(error_message(body)),
        409 if serde_json::from_str::<serde_json::Value>(body).is_ok_and(|value| {
            value
                .pointer("/error/code")
                .and_then(serde_json::Value::as_str)
                == Some("sync_generation_changed")
        }) =>
        {
            TransportError::ReplicaGenerationChanged
        }
        409 if is_pull => TransportError::CursorAhead,
        429 => TransportError::RateLimited(
            retry_after
                .and_then(|v| v.trim().parse::<u64>().ok())
                .map(Duration::from_secs),
        ),
        400..=499 => TransportError::BadRequest(error_message(body)),
        _ => TransportError::Server(format!("HTTP {status}: {}", error_message(body))),
    }
}

fn review_transport_error(status: u16, retry_after: Option<&str>, body: &str) -> TransportError {
    if status == 408 {
        return TransportError::Offline("Timed out waiting for Cloud".into());
    }
    classify_status(status, retry_after, body, false)
}

fn intake_write_error(status: u16, retry_after: Option<&str>, body: &str) -> FormWriteError {
    let code = serde_json::from_str::<serde_json::Value>(body).ok();
    match code
        .as_ref()
        .and_then(|value| value.pointer("/error/code"))
        .and_then(serde_json::Value::as_str)
    {
        Some("version_conflict") => FormWriteError::Conflict,
        Some("storage_limit") => FormWriteError::Capacity,
        _ if (400..500).contains(&status) && !matches!(status, 401 | 403 | 408 | 429) => {
            FormWriteError::Invalid
        }
        _ => review_transport_error(status, retry_after, body).into(),
    }
}

fn read_response<T: serde::de::DeserializeOwned>(
    resp: ureq::http::Response<ureq::Body>,
    is_pull: bool,
) -> Result<T, TransportError> {
    read_response_with(resp, |status, retry_after, body| {
        classify_status(status, retry_after, body, is_pull)
    })
}

fn read_response_with<T: serde::de::DeserializeOwned, E: From<TransportError>>(
    mut resp: ureq::http::Response<ureq::Body>,
    classify: impl FnOnce(u16, Option<&str>, &str) -> E,
) -> Result<T, E> {
    let status = resp.status().as_u16();
    let retry_after = resp
        .headers()
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let body = resp
        .body_mut()
        .read_to_string()
        .map_err(|e| TransportError::Offline(e.to_string()))?;
    if status != 200 && status != 201 {
        return Err(classify(status, retry_after.as_deref(), &body));
    }
    serde_json::from_str(&body).map_err(|e| {
        TransportError::Server(format!(
            "unreadable response ({e}): {}",
            body.chars().take(80).collect::<String>()
        ))
        .into()
    })
}

impl Transport for HttpTransport {
    fn owner_salon_configuration(&self) -> Option<ReviewedSalonConfiguration> {
        let owner = self.session.read().ok()?.as_ref()?.role == "owner";
        owner.then(|| self.salon_configuration().ok()).flatten()
    }

    fn push(&self, request: &PushRequest) -> Result<PushResponse, TransportError> {
        let body = serde_json::to_string(request)
            .map_err(|e| TransportError::BadRequest(e.to_string()))?;
        let mut req = self.agent.post(&format!("{}/sync/push", self.base_url));
        for (k, v) in self.headers()? {
            req = req.header(k, v);
        }
        let resp = req
            .content_type("application/json")
            .send(body)
            .map_err(|e| TransportError::Offline(e.to_string()))?;
        read_response(resp, false)
    }

    fn pull(&self, since: i64, limit: u32) -> Result<PullResponse, TransportError> {
        self.pull_page(since, limit, false, None)
            .map(|result| result.page)
    }

    fn pull_with_catalog_colors(
        &self,
        since: i64,
        limit: u32,
    ) -> Result<(PullResponse, Option<CatalogColors>), TransportError> {
        self.pull_page(since, limit, true, None)
            .map(|result| (result.page, result.catalog_colors))
    }

    fn pull_with_catalogue(
        &self,
        since: i64,
        limit: u32,
        colors: bool,
        snapshots: CatalogueSnapshots,
    ) -> Result<(PullResponse, Option<CatalogColors>), TransportError> {
        self.pull_page(since, limit, colors, Some(snapshots))
            .map(|result| (result.page, result.catalog_colors))
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogPull {
    #[serde(flatten)]
    page: PullResponse,
    catalog_colors: Option<CatalogColors>,
}

impl HttpTransport {
    fn pull_page(
        &self,
        since: i64,
        limit: u32,
        request_colors: bool,
        snapshots: Option<CatalogueSnapshots>,
    ) -> Result<CatalogPull, TransportError> {
        let catalog = if request_colors {
            "&catalogColors=1"
        } else {
            ""
        };
        let catalogue_snapshots = snapshots
            .map(|snapshots| {
                let mode = |full| if full { "full" } else { "delta" };
                format!(
                    "&resourcePools={}&combinations={}",
                    mode(snapshots.full_resource_pools),
                    mode(snapshots.full_combinations)
                )
            })
            .unwrap_or_default();
        let resp = self.get(
            &self.agent,
            &format!(
                "/sync/pull?since={since}&limit={limit}{catalog}&reviewRequests=1&portfolio=1&intakeViews=1&bookingPolicy=1&emailDelivery=1&marketingViews=1&promotionViews=1&whatsappDesk=1&resourceCatalogue=1&inventoryAccess=1&booksyPaymentReview=1&clientGroups=1{catalogue_snapshots}"
            ),
            None,
        )?;
        let result: CatalogPull = read_response(resp, true)?;
        if let Some(role) = result.page.viewer_role.as_deref()
            && self
                .session
                .read()
                .expect("session lock")
                .as_ref()
                .is_some_and(|current| current.role != role)
        {
            return Err(TransportError::Unauthorized);
        }
        Ok(result)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum StreamEnd {
    /// The server closed the stream (shutdown or the periodic reconnect).
    Closed,
    /// The caller asked to stop.
    Stopped,
}

/// Opens `GET /sync/stream` once and forwards every `change` event until the stream ends.
pub fn stream_once(
    transport: &HttpTransport,
    on_connected: &mut dyn FnMut(),
    on_nudge: &mut dyn FnMut(i64),
) -> Result<StreamEnd, TransportError> {
    stream_until(transport, &AtomicBool::new(false), on_connected, on_nudge)
}

fn stream_until(
    transport: &HttpTransport,
    stop: &AtomicBool,
    on_connected: &mut dyn FnMut(),
    on_nudge: &mut dyn FnMut(i64),
) -> Result<StreamEnd, TransportError> {
    let mut resp = transport.get(
        &transport.stream_agent,
        "/sync/stream",
        Some("text/event-stream"),
    )?;
    let status = resp.status().as_u16();
    if status != 200 {
        let retry_after = resp
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let body = resp.body_mut().read_to_string().unwrap_or_default();
        return Err(classify_status(
            status,
            retry_after.as_deref(),
            &body,
            false,
        ));
    }
    on_connected();
    let mut parser = SseParser::default();
    let reader = BufReader::new(resp.into_body().into_reader());
    for line in reader.lines() {
        if stop.load(Ordering::SeqCst) {
            return Ok(StreamEnd::Stopped);
        }
        // A read error mid-stream (budget exhausted, connection dropped) is a normal end.
        let Ok(line) = line else {
            return Ok(StreamEnd::Closed);
        };
        if let Some(event) = parser.feed_line(line.trim_end_matches('\r'))
            && event.event.as_deref() == Some("change")
            && let Some(seq) = nudge_seq(&event)
        {
            on_nudge(seq);
        }
    }
    Ok(StreamEnd::Closed)
}

fn sleep_unless_stopped(total: Duration, stop: &AtomicBool) {
    let step = Duration::from_millis(50);
    let mut left = total;
    while !left.is_zero() && !stop.load(Ordering::SeqCst) {
        let s = step.min(left);
        std::thread::sleep(s);
        left -= s;
    }
}

/// Keeps the nudge stream alive until `stop` is set: reconnects with backoff, reports liveness.
pub fn spawn_stream_listener(
    transport: Arc<HttpTransport>,
    wakes: Sender<Wake>,
    live: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
) -> JoinHandle<()> {
    std::thread::Builder::new()
        .name("sob-sse".into())
        .spawn(move || {
            let mut backoff = Backoff::default();
            while !stop.load(Ordering::SeqCst) {
                let mut connected = false;
                let mut gone = false;
                let result = stream_until(
                    &transport,
                    &stop,
                    &mut || {
                        connected = true;
                        live.store(true, Ordering::SeqCst);
                        // Catch up even when a restore or permission change kept the head
                        // from moving forward. Subsequent head nudges remain coalesced.
                        let _ = wakes.send(Wake::Manual);
                    },
                    &mut |seq| {
                        if wakes.send(Wake::Nudge(seq)).is_err() {
                            gone = true;
                        }
                    },
                );
                live.store(false, Ordering::SeqCst);
                if gone {
                    return;
                }
                match result {
                    Ok(StreamEnd::Stopped) => return,
                    Ok(StreamEnd::Closed) => {
                        if connected {
                            backoff.reset();
                        }
                        sleep_unless_stopped(Duration::from_millis(250), &stop);
                    }
                    Err(e) => {
                        let retry_after = match e {
                            TransportError::RateLimited(after) => after,
                            _ => None,
                        };
                        let delay = Backoff::at_least(backoff.next_delay(), retry_after);
                        sleep_unless_stopped(delay, &stop);
                    }
                }
            }
        })
        .expect("spawn stream thread")
}

#[cfg(test)]
mod tests;
