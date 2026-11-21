use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const LIVE_TOPIC: &str = "loyalty";

#[derive(Deserialize)]
pub struct ClientChoice {
    pub id: Uuid,
    pub name: String,
    pub email: Option<String>,
}

#[derive(Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Policy {
    pub enabled: bool,
    pub earn_every_cents: u32,
    pub points_per_step: u32,
    pub redeem_value_cents: u32,
    pub maximum_discount_basis_points: u32,
    pub expiry_days: Option<u32>,
    pub version: u32,
}

impl Policy {
    pub fn edit(&self, enabled: bool, fields: [&str; 5]) -> Option<Self> {
        let [earn, points, value, maximum, expiry] = fields.map(str::trim);
        let whole = |text: &str| {
            text.bytes()
                .all(|digit| digit.is_ascii_digit())
                .then(|| text.parse::<u32>().ok())
                .flatten()
        };
        let amount = crate::billing::parse_reviewed_amount;
        let expiry_days = if expiry.is_empty() {
            None
        } else {
            Some(whole(expiry).filter(|days| (30..=3650).contains(days))?)
        };
        Some(Self {
            enabled,
            earn_every_cents: amount(earn).filter(|&cents| cents >= 100)?,
            points_per_step: whole(points).filter(|count| (1..=100).contains(count))?,
            redeem_value_cents: amount(value).filter(|cents| (1..=10000).contains(cents))?,
            maximum_discount_basis_points: amount(maximum)
                .filter(|basis_points| (1..=10000).contains(basis_points))?,
            expiry_days,
            version: self.version,
        })
    }
}

#[derive(Clone, PartialEq, Eq, Deserialize)]
pub struct ReviewedPolicy {
    #[serde(flatten)]
    pub policy: Policy,
    pub generation: String,
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
    fn policy_inputs_use_exact_amounts_and_keep_the_reviewed_version() {
        let policy = Policy {
            enabled: false,
            earn_every_cents: 100,
            points_per_step: 1,
            redeem_value_cents: 1,
            maximum_discount_basis_points: 2_000,
            expiry_days: Some(365),
            version: 17,
        };
        let changed = policy
            .edit(true, ["1,50", "3", "0,05", "12,75", ""])
            .unwrap();
        assert_eq!(changed.earn_every_cents, 150);
        assert_eq!(changed.redeem_value_cents, 5);
        assert_eq!(changed.maximum_discount_basis_points, 1_275);
        assert_eq!(changed.expiry_days, None);
        assert_eq!(changed.version, 17);
        assert!(policy.edit(true, ["1", "+3", "0.05", "12", ""]).is_none());
        assert!(
            policy
                .edit(true, ["1", "3", "0.05", "100.01", ""])
                .is_none()
        );
        assert!(policy.edit(true, ["1", "3", "0.05", "10", "29"]).is_none());
    }

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
