use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Deserialize)]
pub struct ClientChoice {
    pub id: Uuid,
    pub name: String,
    pub email: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Policy {
    pub enabled: bool,
    pub earn_every_cents: u32,
    pub points_per_step: u32,
    pub redeem_value_cents: u32,
    pub maximum_discount_basis_points: u32,
    pub expiry_days: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Statement {
    pub policy: Policy,
    pub available_points: u64,
    pub balance_points: i64,
    pub reserved_points: u64,
    pub debt_points: u64,
    pub expiring_points: u64,
    pub movements: Vec<Movement>,
    pub pagination: crate::http::marketing::Pagination,
    // Older servers did not publish an adjustment capability or a reviewed generation.
    #[serde(default)]
    pub can_adjust: bool,
    pub generation: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Movement {
    pub id: Uuid,
    pub kind: String,
    pub points: i64,
    pub checkout_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Adjustment {
    #[serde(skip)]
    pub client_id: Uuid,
    #[serde(skip)]
    pub generation: String,
    pub points: i32,
    pub reason: String,
    pub idempotency_key: Uuid,
}

impl Adjustment {
    pub fn prepare(
        client_id: Uuid,
        generation: String,
        points: &str,
        reason: &str,
    ) -> Option<Self> {
        let points: i32 = points.trim().parse().ok()?;
        let reason = reason.trim();
        if points == 0
            || points.unsigned_abs() > 1_000_000
            || !(8..=300).contains(&reason.encode_utf16().count())
        {
            return None;
        }
        Some(Self {
            client_id,
            generation,
            points,
            reason: reason.to_owned(),
            idempotency_key: Uuid::now_v7(),
        })
    }
}

#[derive(Deserialize)]
pub struct AdjustmentResult {
    pub id: Uuid,
    pub points: i32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adjustments_freeze_a_signed_amount_reason_and_request_key() {
        let id = Uuid::now_v7();
        for input in ["0", "1.5", "1000001", "-2147483648"] {
            assert!(
                Adjustment::prepare(id, "initial".into(), input, "Synthetic review note").is_none()
            );
        }
        let packet =
            Adjustment::prepare(id, "initial".into(), " -30 ", "  Synthetic review note ").unwrap();
        let body = serde_json::to_value(&packet).unwrap();
        assert_eq!(body["points"], -30);
        assert_eq!(body["reason"], "Synthetic review note");
        assert_eq!(body["idempotencyKey"], packet.idempotency_key.to_string());
        assert!(body.get("clientId").is_none());
        assert!(body.get("generation").is_none());
        assert_eq!(packet.clone().idempotency_key, packet.idempotency_key);
    }
}
