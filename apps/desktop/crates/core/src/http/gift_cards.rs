use super::*;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

const PATH: &str = "/admin/gift-cards";

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GiftStatus {
    Pending,
    Active,
    Void,
    Expired,
}

impl GiftStatus {
    pub fn wire(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Active => "active",
            Self::Void => "void",
            Self::Expired => "expired",
        }
    }
}

pub const MAX_GIFT_SERVICES: usize = 50;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GiftOfferTheme {
    #[default]
    Rose,
    Sage,
    Ink,
}

impl GiftOfferTheme {
    pub fn print_accent(self) -> &'static str {
        match self {
            Self::Rose => "#a14468",
            Self::Sage => "#3d7459",
            Self::Ink => "#26354f",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GiftOfferTerms {
    pub name: String,
    pub description: String,
    pub theme: GiftOfferTheme,
    pub amount_cents: u32,
    pub price_cents: u32,
    pub validity_days: Option<u16>,
    pub eligible_service_ids: Vec<Uuid>,
    pub published: bool,
}

impl GiftOfferTerms {
    pub fn canonical(mut self) -> Self {
        // ECMAScript String.trim is used by the Zod contract.
        fn whitespace(character: char) -> bool {
            matches!(character, '\u{9}'..='\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
                | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
        }
        self.name = self.name.trim_matches(whitespace).to_owned();
        self.description = self.description.trim_matches(whitespace).to_owned();
        self.eligible_service_ids.sort_unstable();
        self.eligible_service_ids.dedup();
        self
    }

    pub fn valid(&self) -> bool {
        !self.name.is_empty()
            && self.name.encode_utf16().count() <= 120
            && self.description.encode_utf16().count() <= 500
            && (1..=999_999_999).contains(&self.amount_cents)
            && (1..=999_999_999).contains(&self.price_cents)
            && self
                .validity_days
                .is_none_or(|days| (1..=730).contains(&days))
            && self.eligible_service_ids.len() <= MAX_GIFT_SERVICES
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GiftOffer {
    pub id: Uuid,
    pub version: u32,
    #[serde(flatten)]
    pub terms: GiftOfferTerms,
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct GiftOfferReview {
    pub proposal: GiftOffer,
    pub generation: String,
    pub catalogue_revision: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GiftOfferDesk {
    pub offers: Vec<GiftOffer>,
    pub generation: String,
    pub catalogue_revision: String,
    pub catalogue: Vec<GiftService>,
}

pub fn offer_save_is_terminal(result: Result<(), &TransportError>) -> bool {
    matches!(
        result,
        Ok(()) | Err(TransportError::BadRequest(_) | TransportError::ReplicaGenerationChanged)
    )
}

#[derive(Clone, Deserialize, Serialize)]
pub struct GiftService {
    pub id: Uuid,
    pub name: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GiftBalance {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub eligible_services: Vec<GiftService>,
    pub balance_cents: u32,
    pub reserved_cents: u32,
    pub available_cents: u32,
    pub currency: String,
    pub status: GiftStatus,
    pub code_last4: String,
    pub expires_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GiftCard {
    pub id: Uuid,
    pub label: String,
    pub checkout_id: Uuid,
    pub offer_id: Option<Uuid>,
    pub offer_theme: Option<GiftOfferTheme>,
    pub offer_validity_days: Option<u16>,
    pub amount_cents: u32,
    pub purchase_price_cents: Option<u32>,
    #[serde(flatten)]
    pub balance: GiftBalance,
    pub code_revision: String,
    pub version: u32,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GiftPagination {
    pub page: u32,
    pub page_size: u32,
    pub total: u32,
}

impl GiftPagination {
    pub fn has_next(&self) -> bool {
        self.page.saturating_mul(self.page_size) < self.total
    }
}

#[derive(Clone, Deserialize, Serialize)]
pub struct GiftPage {
    pub cards: Vec<GiftCard>,
    pub pagination: GiftPagination,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GiftMovementKind {
    Activation,
    Redemption,
    RedemptionRefund,
    PurchaseRefund,
    PurchaseRefundReversal,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GiftMovement {
    pub kind: GiftMovementKind,
    pub amount_cents: i64,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct GiftMovements {
    pub movements: Vec<GiftMovement>,
    pub pagination: GiftPagination,
    pub replica: Option<GiftReplicaStamp>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct GiftReplicaStamp {
    pub scope: String,
    pub generation: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GiftPurchase {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub eligible_service_ids: Vec<Uuid>,
    pub amount_cents: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub purchase_price_cents: Option<u32>,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub buyer_client_id: Option<Uuid>,
    pub expires_at: Option<DateTime<Utc>>,
    pub idempotency_key: Uuid,
    #[serde(skip)]
    pub generation: String,
}

impl GiftPurchase {
    pub fn price_cents(&self) -> u32 {
        self.purchase_price_cents.unwrap_or(self.amount_cents)
    }

    pub fn restrict_to(mut self, ids: &[Uuid]) -> Option<Self> {
        self.eligible_service_ids = ids.to_vec();
        self.eligible_service_ids.sort_unstable();
        self.eligible_service_ids.dedup();
        (self.eligible_service_ids.len() <= MAX_GIFT_SERVICES).then_some(self)
    }

    pub fn review(
        amount: &str,
        price: &str,
        label: &str,
        buyer_client_id: Option<Uuid>,
        expires_at: Option<DateTime<Utc>>,
        generation: String,
        now: DateTime<Utc>,
    ) -> Option<Self> {
        let amount_cents =
            crate::billing::parse_reviewed_amount(amount).filter(|value| *value != 0)?;
        let purchase_price_cents = if price.trim().is_empty() {
            None
        } else {
            Some(crate::billing::parse_reviewed_amount(price).filter(|value| *value != 0)?)
                .filter(|value| *value != amount_cents)
        };
        let label = label.trim();
        if label.encode_utf16().count() > 120 || expires_at.is_some_and(|date| date <= now) {
            return None;
        }
        Some(Self {
            eligible_service_ids: Vec::new(),
            amount_cents,
            purchase_price_cents,
            label: label.to_owned(),
            buyer_client_id,
            expires_at,
            idempotency_key: Uuid::now_v7(),
            generation,
        })
    }
}

#[derive(Deserialize)]
pub struct GiftPurchaseResult {
    pub card: GiftCard,
    pub checkout: AppointmentCheckout,
}

#[derive(Deserialize)]
pub struct GiftReveal {
    pub code: String,
    pub card: GiftCard,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReplicaPage {
    scope: String,
    generation: String,
    revision: i64,
    through: i64,
    rows: Vec<GiftCard>,
    has_more: bool,
}

pub struct GiftCatalogue {
    pub scope: String,
    pub generation: String,
    pub through: i64,
    pub saved_at: DateTime<Utc>,
    pub cards: Vec<GiftCard>,
}

impl GiftCatalogue {
    pub fn search(
        &self,
        page: u32,
        search: &str,
        status: Option<GiftStatus>,
        now: DateTime<Utc>,
    ) -> GiftPage {
        self.search_filtered(page, search, status, now, false)
    }

    pub fn search_filtered(
        &self,
        page: u32,
        search: &str,
        status: Option<GiftStatus>,
        now: DateTime<Utc>,
        pending_orders: bool,
    ) -> GiftPage {
        const PAGE_SIZE: usize = 20;
        let label_term = search.to_lowercase();
        let page = usize::try_from(page.max(1)).unwrap_or(usize::MAX);
        let start = page.saturating_sub(1).saturating_mul(PAGE_SIZE);
        let mut total = 0u32;
        let mut cards = Vec::with_capacity(PAGE_SIZE);
        for card in &self.cards {
            let current_status = card.balance.status_at(now);
            if (pending_orders
                && (card.offer_id.is_none() || current_status != GiftStatus::Pending))
                || status.is_some_and(|status| current_status != status)
                || (!label_term.is_empty()
                    && !card.balance.code_last4.eq_ignore_ascii_case(search)
                    && !card.label.to_lowercase().contains(&label_term))
            {
                continue;
            }
            if usize::try_from(total).is_ok_and(|index| index >= start) && cards.len() < PAGE_SIZE {
                let mut card = card.clone();
                card.balance.status = current_status;
                cards.push(card);
            }
            total = total.saturating_add(1);
        }
        GiftPage {
            cards,
            pagination: GiftPagination {
                page: u32::try_from(page).unwrap_or(u32::MAX),
                page_size: PAGE_SIZE as u32,
                total,
            },
        }
    }

    pub fn card(&self, id: Uuid, now: DateTime<Utc>) -> Option<GiftCard> {
        let mut card = self.cards.iter().find(|card| card.id == id)?.clone();
        card.balance.status = card.balance.status_at(now);
        Some(card)
    }
}

impl GiftBalance {
    fn status_at(&self, now: DateTime<Utc>) -> GiftStatus {
        if self.status == GiftStatus::Active && self.expires_at.is_some_and(|expiry| expiry <= now)
        {
            GiftStatus::Expired
        } else {
            self.status
        }
    }
}

impl HttpTransport {
    pub fn can_manage_gift_cards(&self) -> Result<bool, TransportError> {
        #[derive(Deserialize)]
        struct Permission {
            refunds: bool,
        }
        #[derive(Deserialize)]
        struct Capabilities {
            permissions: Option<Permission>,
        }
        let response: Capabilities = self.gift_get("/admin/commerce/capabilities")?;
        Ok(response
            .permissions
            .is_some_and(|permission| permission.refunds))
    }

    pub fn gift_catalogue(
        &self,
        scope: &str,
        generation: &str,
    ) -> Result<GiftCatalogue, TransportError> {
        let mut cards = Vec::new();
        let mut seen = std::collections::HashSet::new();
        let mut revision = None;
        for page in 1..=100_000 {
            let response: ReplicaPage = self.gift_get(&format!("{PATH}/replica?page={page}"))?;
            if response.scope != scope || response.generation != generation {
                return Err(TransportError::ReplicaGenerationChanged);
            }
            if response.revision < 0
                || response.through < response.revision
                || revision.is_some_and(|seq| response.revision != seq)
            {
                return Err(TransportError::Server(
                    "Gift register changed during download".into(),
                ));
            }
            if response.rows.len() > 128
                || response.has_more && response.rows.len() != 128
                || !response.rows.iter().all(|card| {
                    seen.insert(card.id)
                        && card.balance.currency == "EUR"
                        && card.balance.code_last4.len() == 4
                        && card
                            .balance
                            .code_last4
                            .bytes()
                            .all(|byte| byte.is_ascii_hexdigit())
                })
            {
                return Err(TransportError::Server("Invalid gift register page".into()));
            }
            revision = Some(response.revision);
            cards.extend(response.rows);
            if !response.has_more {
                return Ok(GiftCatalogue {
                    scope: scope.to_owned(),
                    generation: generation.to_owned(),
                    through: response.through,
                    saved_at: Utc::now(),
                    cards,
                });
            }
        }
        Err(TransportError::Server(
            "Gift register pagination exceeded the API limit".into(),
        ))
    }

    pub fn gift_cards(
        &self,
        page: u32,
        search: &str,
        status: Option<GiftStatus>,
    ) -> Result<GiftPage, TransportError> {
        self.gift_cards_filtered(page, search, status, false)
    }

    pub fn gift_cards_filtered(
        &self,
        page: u32,
        search: &str,
        status: Option<GiftStatus>,
        pending_orders: bool,
    ) -> Result<GiftPage, TransportError> {
        let mut query = url::form_urlencoded::Serializer::new(String::new());
        query.append_pair("page", &page.to_string());
        if pending_orders {
            query.append_pair("pendingOffer", "1");
        }
        if !search.is_empty() {
            query.append_pair("search", search);
        }
        if let Some(status) = status {
            query.append_pair("status", status.wire());
        }
        self.gift_get(&format!("{PATH}?{}", query.finish()))
    }

    pub fn gift_offers(&self) -> Result<GiftOfferDesk, TransportError> {
        self.gift_get(&format!("{PATH}/offers"))
    }

    pub fn save_gift_offer(&self, reviewed: &GiftOfferReview) -> Result<GiftOffer, TransportError> {
        let offer = &reviewed.proposal;
        let terms = offer.terms.clone().canonical();
        if !terms.valid() || reviewed.generation.is_empty() || offer.version >= i32::MAX as u32 {
            return Err(TransportError::BadRequest(
                "Invalid gift offer review".into(),
            ));
        }
        let mut fields = serde_json::to_value(&terms)
            .map_err(|error| TransportError::BadRequest(error.to_string()))?;
        fields["version"] = offer.version.into();
        fields["generation"] = reviewed.generation.clone().into();
        fields["catalogueRevision"] = reviewed.catalogue_revision.clone().into();
        let response = self.send_put_json_with_headers(
            &format!("{PATH}/offers/{}", offer.id),
            &fields,
            &[("x-citame-generation", &reviewed.generation)],
        )?;
        let saved: GiftOffer = read_response_with(response, gift_offer_save_error)?;
        if saved.id != offer.id
            || saved.version == 0
            || !(offer.version..=offer.version.saturating_add(1)).contains(&saved.version)
            || saved.terms != terms
        {
            return Err(TransportError::Server(
                "Unexpected gift offer acknowledgement".into(),
            ));
        }
        Ok(saved)
    }

    pub fn gift_eligible_services(&self) -> Result<Vec<GiftService>, TransportError> {
        #[derive(Deserialize)]
        struct Catalog {
            services: Vec<GiftService>,
        }
        Ok(self
            .gift_get::<Catalog>(&format!("{PATH}/eligible-services"))?
            .services)
    }

    pub fn gift_card(&self, id: Uuid) -> Result<GiftCard, TransportError> {
        self.gift_get(&format!("{PATH}/{id}"))
    }

    pub fn gift_card_movements(
        &self,
        id: Uuid,
        page: u32,
    ) -> Result<GiftMovements, TransportError> {
        self.gift_get(&format!("{PATH}/{id}/movements?page={page}"))
    }

    pub fn purchase_gift_card(
        &self,
        input: &GiftPurchase,
    ) -> Result<GiftPurchaseResult, TransportError> {
        let headers = [("x-citame-generation", input.generation.as_str())];
        let mut purchase: GiftPurchaseResult = read_response_with(
            self.send_json_with_headers(PATH, input, &headers)?,
            gift_purchase_error,
        )?;
        let mut eligible_service_ids = purchase
            .card
            .balance
            .eligible_services
            .iter()
            .map(|service| service.id)
            .collect::<Vec<_>>();
        eligible_service_ids.sort_unstable();
        if parse_id(&purchase.checkout.id).ok() != Some(purchase.card.checkout_id)
            || purchase.card.amount_cents != input.amount_cents
            || purchase.checkout.total_cents != input.price_cents()
            || purchase
                .card
                .purchase_price_cents
                .unwrap_or(purchase.card.amount_cents)
                != input.price_cents()
            || purchase.card.balance.currency != "EUR"
            || eligible_service_ids != input.eligible_service_ids
        {
            return Err(TransportError::Server(
                "Unexpected gift purchase receipt".into(),
            ));
        }
        purchase.checkout = validate_checkout(purchase.checkout, None, None)?;
        Ok(purchase)
    }

    pub fn check_gift_card(&self, code: &str) -> Result<GiftBalance, TransportError> {
        use crate::billing::normalize_gift_card_code;
        let code = normalize_gift_card_code(code)
            .ok_or_else(|| TransportError::BadRequest("Invalid gift card code".into()))?;
        self.post_json(
            &format!("{PATH}/check"),
            &serde_json::json!({ "code": code }),
        )
    }

    pub fn reveal_gift_card(&self, id: Uuid) -> Result<GiftReveal, TransportError> {
        self.post_json(&format!("{PATH}/{id}/code"), &serde_json::json!({}))
    }

    pub fn reissue_gift_card(
        &self,
        id: Uuid,
        version: u32,
        reason: &str,
        generation: &str,
    ) -> Result<GiftCard, TransportError> {
        let body = serde_json::json!({ "version": version, "reason": reason });
        let headers = [("x-citame-generation", generation)];
        read_response(
            self.send_json_with_headers(&format!("{PATH}/{id}/reissue"), &body, &headers)?,
            false,
        )
    }

    pub fn change_gift_card_expiry(
        &self,
        id: Uuid,
        version: u32,
        reason: &str,
        expires_at: Option<DateTime<Utc>>,
        generation: &str,
    ) -> Result<GiftCard, TransportError> {
        let body =
            serde_json::json!({ "version": version, "reason": reason, "expiresAt": expires_at });
        let mut request = self
            .agent
            .patch(&format!("{}{PATH}/{id}/expiry", self.base_url));
        for (name, value) in self.headers()? {
            request = request.header(name, value);
        }
        let response = request
            .header("x-citame-generation", generation)
            .content_type("application/json")
            .send(body.to_string())
            .map_err(|error| TransportError::Offline(error.to_string()))?;
        read_response(response, false)
    }

    fn gift_get<T: serde::de::DeserializeOwned>(&self, path: &str) -> Result<T, TransportError> {
        read_response(
            self.get(&self.agent, path, Some("application/json"))?,
            false,
        )
    }
}

fn gift_offer_save_error(status: u16, retry_after: Option<&str>, body: &str) -> TransportError {
    let error = review_transport_error(status, retry_after, body);
    if matches!(error, TransportError::BadRequest(_)) {
        let response = serde_json::from_str::<serde_json::Value>(body).ok();
        let code = response
            .as_ref()
            .and_then(|body| body.pointer("/error/code"))
            .and_then(serde_json::Value::as_str);
        if !matches!(
            (status, code),
            (400, Some("validation_error")) | (409, Some("version_conflict"))
        ) {
            return TransportError::Server(format!("Unconfirmed Cloud response (HTTP {status})"));
        }
    }
    error
}

fn gift_purchase_error(status: u16, retry_after: Option<&str>, body: &str) -> TransportError {
    let error = review_transport_error(status, retry_after, body);
    if matches!(error, TransportError::BadRequest(_)) {
        let response = serde_json::from_str::<serde_json::Value>(body).ok();
        let code = response
            .as_ref()
            .and_then(|body| body.pointer("/error/code"))
            .and_then(serde_json::Value::as_str);
        if !matches!(
            (status, code),
            (400, Some("validation_error")) | (409, Some("client_merged" | "storage_limit"))
        ) {
            return TransportError::Server(format!("Unconfirmed Cloud response (HTTP {status})"));
        }
    }
    error
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gift_purchase_keeps_unconfirmed_responses_retryable() {
        assert!(matches!(
            gift_purchase_error(408, None, ""),
            TransportError::Offline(_)
        ));
        assert!(matches!(
            gift_purchase_error(404, None, "<html>upstream error</html>"),
            TransportError::Server(_)
        ));
        assert!(matches!(
            gift_purchase_error(404, None, r#"{"error":{"code":"not_found"}}"#),
            TransportError::Server(_)
        ));
        assert!(matches!(
            gift_purchase_error(400, None, r#"{"error":{"code":"validation_error"}}"#),
            TransportError::BadRequest(_)
        ));
        assert_eq!(
            gift_purchase_error(409, None, r#"{"error":{"code":"sync_generation_changed"}}"#),
            TransportError::ReplicaGenerationChanged
        );
    }
}
