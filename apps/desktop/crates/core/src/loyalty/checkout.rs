use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::promotions::{Timing, valid_code};
use crate::sync::TransportError;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Choice {
    Points { points: u32 },
    Promotion { code: String },
}

impl Choice {
    pub fn points(input: &str) -> Option<Self> {
        let points = input.trim();
        if !points.bytes().all(|digit| digit.is_ascii_digit()) {
            return None;
        }
        let points = points.parse().ok()?;
        (1..=1_000_000_000)
            .contains(&points)
            .then_some(Self::Points { points })
    }

    pub fn promotion(input: &str) -> Option<Self> {
        let code = input.trim().to_ascii_uppercase();
        valid_code(&code).then_some(Self::Promotion { code })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RewardKind {
    Points,
    Promotion,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppointmentTiming {
    pub timing: Timing,
    pub time_zone: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Quote {
    pub name: String,
    pub kind: RewardKind,
    pub points_used: u32,
    pub maximum_points: u32,
    pub discount_cents: u32,
    pub current_total_cents: u32,
    pub new_total_cents: u32,
    pub promotion_version: Option<u32>,
    pub appointment_timing: Option<AppointmentTiming>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Application {
    #[serde(flatten)]
    choice: Choice,
    expected_total_cents: u32,
    expected_discount_cents: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    expected_promotion_version: Option<u32>,
    idempotency_key: Uuid,
}

impl Application {
    pub fn reviewed(choice: Choice, quote: &Quote, receipt_total: u32) -> Option<Self> {
        let valid_kind = match &choice {
            Choice::Points { points } => {
                quote.kind == RewardKind::Points
                    && quote.points_used == *points
                    && *points <= quote.maximum_points
            }
            Choice::Promotion { .. } => {
                quote.kind == RewardKind::Promotion
                    && quote.points_used == 0
                    && (quote.appointment_timing.is_none() || quote.promotion_version.is_some())
            }
        };
        if !valid_kind
            || quote.current_total_cents != receipt_total
            || quote.discount_cents == 0
            || receipt_total.checked_sub(quote.discount_cents) != Some(quote.new_total_cents)
        {
            return None;
        }
        Some(Self {
            choice,
            expected_total_cents: receipt_total,
            expected_discount_cents: quote.discount_cents,
            expected_promotion_version: quote.promotion_version,
            idempotency_key: Uuid::now_v7(),
        })
    }

    pub(crate) fn acknowledges(&self, reward: &crate::billing::ReceiptReward) -> bool {
        self.expected_discount_cents == reward.discount_cents
            && match &self.choice {
                Choice::Points { points } => {
                    reward.kind == RewardKind::Points && reward.points_used == *points
                }
                Choice::Promotion { code } => {
                    reward.kind == RewardKind::Promotion && reward.code.as_ref() == Some(code)
                }
            }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct ReturnPoints {
    reason: String,
}

impl ReturnPoints {
    pub fn reviewed(reason: &str) -> Option<Self> {
        let reason = reason.trim();
        (8..=300)
            .contains(&reason.encode_utf16().count())
            .then(|| Self {
                reason: reason.to_owned(),
            })
    }
}

#[derive(Debug, thiserror::Error)]
pub enum RewardError {
    #[error("the receipt or reward terms changed")]
    Conflict,
    #[error("the receipt does not match the promotion's appointment conditions")]
    Timing,
    #[error(transparent)]
    Transport(#[from] TransportError),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timed_quote_freezes_the_exact_application_and_replays_the_same_key() {
        let choice = Choice::promotion("  cuT_5  ").unwrap();
        let quote = Quote {
            name: "Reviewed sale".into(),
            kind: RewardKind::Promotion,
            points_used: 0,
            maximum_points: 0,
            discount_cents: 500,
            current_total_cents: 2500,
            new_total_cents: 2000,
            promotion_version: Some(8),
            appointment_timing: Some(AppointmentTiming {
                timing: Timing {
                    weekdays: vec![1],
                    start_minute: 600,
                    end_minute: 900,
                    last_minute_hours: None,
                },
                time_zone: "Europe/Madrid".into(),
            }),
        };
        assert!(Application::reviewed(choice.clone(), &quote, 2400).is_none());
        let reviewed = Application::reviewed(choice, &quote, 2500).unwrap();
        let body = serde_json::to_value(&reviewed).unwrap();
        assert_eq!(body["code"], "CUT_5");
        assert_eq!(body["expectedPromotionVersion"], 8);
        assert_eq!(body["expectedTotalCents"], 2500);
        assert_eq!(body["expectedDiscountCents"], 500);
        assert_eq!(serde_json::to_value(reviewed.clone()).unwrap(), body);
        assert!(Choice::points("+10").is_none());
        assert!(ReturnPoints::reviewed("short").is_none());
    }
}
