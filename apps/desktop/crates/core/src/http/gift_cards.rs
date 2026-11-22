use super::*;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

const PATH: &str = "/admin/gift-cards";

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GiftBalance {
    pub balance_cents: u32,
    pub reserved_cents: u32,
    pub available_cents: u32,
    pub currency: String,
    pub status: GiftStatus,
    pub code_last4: String,
    pub expires_at: Option<DateTime<Utc>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GiftCard {
    pub id: Uuid,
    pub label: String,
    pub checkout_id: Uuid,
    pub amount_cents: u32,
    #[serde(flatten)]
    pub balance: GiftBalance,
    pub code_revision: String,
    pub version: u32,
}

#[derive(Deserialize)]
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

#[derive(Deserialize)]
pub struct GiftPage {
    pub cards: Vec<GiftCard>,
    pub pagination: GiftPagination,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GiftMovementKind {
    Activation,
    Redemption,
    RedemptionRefund,
    PurchaseRefund,
    PurchaseRefundReversal,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GiftMovement {
    pub kind: GiftMovementKind,
    pub amount_cents: i64,
    pub created_at: DateTime<Utc>,
}

#[derive(Deserialize)]
pub struct GiftMovements {
    pub movements: Vec<GiftMovement>,
    pub pagination: GiftPagination,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GiftPurchase {
    pub amount_cents: u32,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub buyer_client_id: Option<Uuid>,
    pub expires_at: Option<DateTime<Utc>>,
    pub idempotency_key: Uuid,
    #[serde(skip)]
    pub generation: String,
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

    pub fn gift_cards(
        &self,
        page: u32,
        search: &str,
        status: Option<GiftStatus>,
    ) -> Result<GiftPage, TransportError> {
        let mut query = url::form_urlencoded::Serializer::new(String::new());
        query.append_pair("page", &page.to_string());
        if !search.is_empty() {
            query.append_pair("search", search);
        }
        if let Some(status) = status {
            query.append_pair("status", status.wire());
        }
        self.gift_get(&format!("{PATH}?{}", query.finish()))
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
        let mut purchase: GiftPurchaseResult =
            read_response(self.send_json_with_headers(PATH, input, &headers)?, false)?;
        if parse_id(&purchase.checkout.id).ok() != Some(purchase.card.checkout_id)
            || purchase.card.amount_cents != input.amount_cents
            || purchase.checkout.total_cents != input.amount_cents
            || purchase.card.balance.currency != "EUR"
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
