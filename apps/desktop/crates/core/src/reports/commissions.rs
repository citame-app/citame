use std::fmt::Write;

use chrono::{DateTime, SecondsFormat, Utc};
use serde::Deserialize;

use super::financial::{CURRENCY, csv_text};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommissionScope {
    pub staff_id: Option<String>,
    pub can_choose_staff: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommissionStatement {
    pub staff_id: String,
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
