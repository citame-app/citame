use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub mod checkout;

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

#[derive(Clone, Copy)]
pub struct PolicyFields<'a> {
    pub earn_amount: &'a str,
    pub points_per_step: &'a str,
    pub redeem_value: &'a str,
    pub maximum_discount: &'a str,
    pub expiry_days: &'a str,
}

impl Policy {
    pub fn edit(&self, enabled: bool, fields: PolicyFields<'_>) -> Option<Self> {
        let whole = |text: &str| {
            let text = text.trim();
            text.bytes()
                .all(|digit| digit.is_ascii_digit())
                .then(|| text.parse::<u32>().ok())
                .flatten()
        };
        let amount = crate::billing::parse_reviewed_amount;
        let expiry_days = if fields.expiry_days.trim().is_empty() {
            None
        } else {
            Some(whole(fields.expiry_days).filter(|days| (30..=3650).contains(days))?)
        };
        Some(Self {
            enabled,
            earn_every_cents: amount(fields.earn_amount).filter(|&cents| cents >= 100)?,
            points_per_step: whole(fields.points_per_step)
                .filter(|count| (1..=100).contains(count))?,
            redeem_value_cents: amount(fields.redeem_value)
                .filter(|cents| (1..=10000).contains(cents))?,
            maximum_discount_basis_points: amount(fields.maximum_discount)
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
        let fields = PolicyFields {
            earn_amount: "1,50",
            points_per_step: "3",
            redeem_value: "0,05",
            maximum_discount: "12,75",
            expiry_days: "",
        };
        let changed = policy.edit(true, fields).unwrap();
        assert_eq!(changed.earn_every_cents, 150);
        assert_eq!(changed.redeem_value_cents, 5);
        assert_eq!(changed.maximum_discount_basis_points, 1_275);
        assert_eq!(changed.expiry_days, None);
        assert_eq!(changed.version, 17);
        assert!(
            policy
                .edit(
                    true,
                    PolicyFields {
                        points_per_step: "+3",
                        ..fields
                    }
                )
                .is_none()
        );
        assert!(
            policy
                .edit(
                    true,
                    PolicyFields {
                        maximum_discount: "100.01",
                        ..fields
                    }
                )
                .is_none()
        );
        assert!(
            policy
                .edit(
                    true,
                    PolicyFields {
                        expiry_days: "29",
                        ..fields
                    }
                )
                .is_none()
        );
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
