use std::fmt::Write;

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};

use super::financial::{CURRENCY, csv_text};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommissionScope {
    pub staff_id: Option<String>,
    pub can_choose_staff: bool,
    #[serde(default)]
    pub can_manage: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommissionPolicy {
    pub staff_id: String,
    pub generation: String,
    pub version: Option<u32>,
    pub service_basis_points: u16,
    pub product_basis_points: u16,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommissionRateEdit {
    pub generation: String,
    pub version: Option<u32>,
    pub service_basis_points: u16,
    pub product_basis_points: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommissionPayoutReview {
    pub actor_user_id: String,
    pub generation: String,
    pub amount_cents: u32,
    pub reference: String,
    pub idempotency_key: uuid::Uuid,
}

impl CommissionPayoutReview {
    pub fn new(
        actor_user_id: String,
        generation: String,
        amount_cents: u32,
        reference: &str,
    ) -> Option<Self> {
        let reference = crate::trim_like_javascript(reference);
        (amount_cents > 0 && (8..=300).contains(&reference.encode_utf16().count())).then(|| Self {
            actor_user_id,
            generation,
            amount_cents,
            reference: reference.into(),
            idempotency_key: uuid::Uuid::now_v7(),
        })
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavedCommissionPayout {
    pub staff_id: uuid::Uuid,
    pub review: CommissionPayoutReview,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedCommissionPayout {
    pub id: uuid::Uuid,
    pub staff_id: uuid::Uuid,
    pub idempotency_key: uuid::Uuid,
    pub amount_cents: u32,
    pub reference: String,
}

#[derive(Debug, thiserror::Error)]
pub enum CommissionPayoutError {
    #[error("Commission balance changed")]
    BalanceChanged,
    #[error("Commission payout review rejected by validation")]
    InvalidReview,
    #[error("Commission payout key belongs to another request")]
    KeyConflict,
    #[error("No matching commission payout was recorded")]
    NoMatch,
    #[error(transparent)]
    Transport(#[from] crate::sync::TransportError),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommissionStatement {
    pub staff_id: String,
    pub generation: Option<String>,
    pub earned_cents: i64,
    pub paid_cents: i64,
    pub outstanding_cents: i64,
    pub accruals: Vec<CommissionAccrual>,
    pub payouts: Vec<CommissionPayout>,
    pub pagination: CommissionPage,
    pub payout_pagination: CommissionPage,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommissionAccrual {
    pub checkout_id: uuid::Uuid,
    pub description: String,
    pub kind: String,
    pub basis_cents: i64,
    pub rate_basis_points: u16,
    pub original_cents: i64,
    pub adjusted_cents: i64,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommissionPayout {
    pub amount_cents: i64,
    pub reference: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommissionPage {
    pub page: u32,
    pub page_size: u32,
    pub total: u64,
}

impl CommissionPage {
    pub fn has_next(&self) -> bool {
        self.page < 100_000 && u64::from(self.page) * u64::from(self.page_size) < self.total
    }
}

impl CommissionStatement {
    pub fn accrual_csv(&self) -> String {
        let mut csv = String::from(
            "\u{feff}\"checkout_id\",\"description\",\"kind\",\"basis_cents\",\"rate_basis_points\",\"original_cents\",\"after_refunds_cents\",\"currency\",\"earned_at\"",
        );
        for row in &self.accruals {
            let _ = write!(
                csv,
                "\r\n\"{}\",{},{},\"{}\",\"{}\",\"{}\",\"{}\",\"{CURRENCY}\",\"{}\"",
                row.checkout_id,
                csv_text(&row.description),
                csv_text(&row.kind),
                row.basis_cents,
                row.rate_basis_points,
                row.original_cents,
                row.adjusted_cents,
                row.created_at.to_rfc3339_opts(SecondsFormat::Millis, true)
            );
        }
        csv
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payout_review_trims_references_the_same_way_as_the_api() {
        let make = |reference| {
            CommissionPayoutReview::new("owner".into(), "initial".into(), 1200, reference)
        };
        assert_eq!(make("\u{feff}12345678 ").unwrap().reference, "12345678");
        assert!(make("\u{feff}1234567 ").is_none());
        assert_eq!(
            make("\u{0085}12345678").unwrap().reference,
            "\u{0085}12345678"
        );
    }
}
