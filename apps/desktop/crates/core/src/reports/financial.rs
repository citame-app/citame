use std::fmt::Write;

use chrono::{DateTime, NaiveDate, SecondsFormat, Utc};
use serde::Deserialize;

use crate::i18n::Key;

pub const CURRENCY: &str = "EUR";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinancialReport {
    pub from: NaiveDate,
    pub to: NaiveDate,
    pub timezone: String,
    pub client: Option<FinancialClient>,
    pub collected_cents: i64,
    pub refunded_cents: i64,
    pub net_collected_cents: i64,
    pub sold_cents: i64,
    pub included_tax_cents: i64,
    pub tips_cents: i64,
    pub product_cost_cents: i64,
    #[serde(default)]
    pub stored_value_applied_cents: i64,
    #[serde(default)]
    pub stored_value_returned_cents: i64,
    #[serde(default)]
    pub gift_value_issued_cents: i64,
    #[serde(default)]
    pub prepaid_applied_cents: i64,
    #[serde(default)]
    pub prepaid_returned_cents: i64,
    #[serde(default)]
    pub prepaid_allocated_cents: i64,
    #[serde(default)]
    pub prepaid_allocation_returned_cents: i64,
    #[serde(default)]
    pub membership_access_fees_cents: i64,
    #[serde(default)]
    pub booking_fees_cents: i64,
    pub unknown_cost_lines: u64,
    pub settled_by_family: Option<Vec<SalesFamilyTotal>>,
    pub methods: Vec<FinancialMethod>,
    pub cash_sessions: Vec<FinancialSession>,
}

#[derive(Debug, Deserialize)]
pub struct FinancialClient {
    pub id: uuid::Uuid,
    pub name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SalesFamilyTotal {
    pub family: SalesFamily,
    pub amount_cents: i64,
    pub tax_cents: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SalesFamily {
    Service,
    Product,
    Custom,
    GiftCard,
    PackagePurchase,
    MembershipPeriod,
    Other,
    Unallocated,
}

impl SalesFamily {
    pub fn descriptor(&self) -> (&'static str, Key) {
        match self {
            Self::Service => ("service", Key::FinancialFamilyService),
            Self::Product => ("product", Key::FinancialFamilyProduct),
            Self::Custom => ("custom", Key::FinancialFamilyCustom),
            Self::GiftCard => ("gift_card", Key::FinancialFamilyGift),
            Self::PackagePurchase => ("package_purchase", Key::FinancialFamilyPackage),
            Self::MembershipPeriod => ("membership_period", Key::FinancialFamilyMembership),
            Self::Other => ("other", Key::FinancialFamilyOther),
            Self::Unallocated => ("unallocated", Key::FinancialFamilyUnallocated),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinancialMethod {
    pub method: String,
    pub collected_cents: i64,
    pub refunded_cents: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinancialSession {
    pub id: uuid::Uuid,
    pub opened_at: DateTime<Utc>,
    pub closed_at: Option<DateTime<Utc>>,
    pub opening_cents: i64,
    pub expected_cents: Option<i64>,
    pub counted_cents: Option<i64>,
    pub difference_cents: Option<i64>,
}

impl FinancialReport {
    pub fn csv_filename(&self) -> String {
        match &self.client {
            Some(client) => format!("client-sales-{}-{}-{}.csv", client.id, self.from, self.to),
            None => format!("financial-summary-{}-{}.csv", self.from, self.to),
        }
    }

    pub fn metrics(&self) -> [(&'static str, Key, i64); 16] {
        [
            ("collected", Key::FinancialCollected, self.collected_cents),
            ("refunds", Key::FinancialRefunded, self.refunded_cents),
            (
                "net_collections",
                Key::FinancialNet,
                self.net_collected_cents,
            ),
            ("settled_sales", Key::FinancialSettled, self.sold_cents),
            (
                "included_tax_at_sale",
                Key::FinancialTax,
                self.included_tax_cents,
            ),
            ("settled_tips", Key::FinancialTips, self.tips_cents),
            (
                "known_product_cost_at_sale",
                Key::FinancialCost,
                self.product_cost_cents,
            ),
            (
                "gift_value_applied",
                Key::FinancialGiftApplied,
                self.stored_value_applied_cents,
            ),
            (
                "gift_value_returned",
                Key::FinancialGiftReturned,
                self.stored_value_returned_cents,
            ),
            (
                "gift_value_issued",
                Key::FinancialGiftIssued,
                self.gift_value_issued_cents,
            ),
            (
                "prepaid_visits_face_applied",
                Key::FinancialPrepaidApplied,
                self.prepaid_applied_cents,
            ),
            (
                "prepaid_visits_face_returned",
                Key::FinancialPrepaidReturned,
                self.prepaid_returned_cents,
            ),
            (
                "prepaid_visits_allocated",
                Key::FinancialPrepaidAllocated,
                self.prepaid_allocated_cents,
            ),
            (
                "prepaid_visits_allocation_returned",
                Key::FinancialPrepaidAllocationReturned,
                self.prepaid_allocation_returned_cents,
            ),
            (
                "membership_access_fees",
                Key::FinancialMembershipFees,
                self.membership_access_fees_cents,
            ),
            (
                "booking_fees",
                Key::FinancialBookingFees,
                self.booking_fees_cents,
            ),
        ]
    }

    pub fn to_csv(&self) -> String {
        let mut csv = String::from("\u{feff}");
        if let Some(client) = &self.client {
            let _ = write!(csv, "\"client_id\",\"{}\"\r\n\r\n", client.id);
        }
        csv.push_str("\"from\",\"to\",\"timezone\",\"metric\",\"amount_cents\",\"currency\"\r\n");
        let timezone = csv_text(&self.timezone);
        for (metric, _, cents) in self.metrics() {
            let _ = write!(
                csv,
                "\"{}\",\"{}\",{timezone},\"{metric}\",\"{cents}\",\"{CURRENCY}\"\r\n",
                self.from, self.to
            );
        }
        csv.push_str(
            "\r\n\"method\",\"tender_applied_cents\",\"tender_returned_cents\",\"currency\"\r\n",
        );
        for entry in &self.methods {
            let _ = write!(
                csv,
                "{},\"{}\",\"{}\",\"{CURRENCY}\"\r\n",
                csv_text(&entry.method),
                entry.collected_cents,
                entry.refunded_cents
            );
        }
        csv.push_str("\r\n\"cash_session_id\",\"opened_at\",\"closed_at\",\"opening_cents\",\"expected_cents\",\"counted_cents\",\"difference_cents\",\"currency\"");
        let instant = |at: DateTime<Utc>| at.to_rfc3339_opts(SecondsFormat::Millis, true);
        let optional =
            |value: Option<i64>| value.map(|amount| amount.to_string()).unwrap_or_default();
        for entry in &self.cash_sessions {
            let _ = write!(
                csv,
                "\r\n\"{}\",\"{}\",\"{}\",\"{}\",\"{}\",\"{}\",\"{}\",\"{CURRENCY}\"",
                entry.id,
                instant(entry.opened_at),
                entry.closed_at.map(instant).unwrap_or_default(),
                entry.opening_cents,
                optional(entry.expected_cents),
                optional(entry.counted_cents),
                optional(entry.difference_cents)
            );
        }
        if let Some(rows) = &self.settled_by_family {
            csv.push_str("\r\n\r\n\"sale_family\",\"settled_amount_cents\",\"included_tax_cents\",\"currency\"");
            for row in rows {
                let (family, _) = row.family.descriptor();
                let _ = write!(
                    csv,
                    "\r\n\"{family}\",\"{}\",\"{}\",\"{CURRENCY}\"",
                    row.amount_cents, row.tax_cents
                );
            }
        }
        csv
    }
}

pub(super) fn csv_text(value: &str) -> String {
    let prefix = if value.trim_start().starts_with(['=', '+', '-', '@']) {
        "'"
    } else {
        ""
    };
    format!("\"{prefix}{}\"", value.replace('"', "\"\""))
}
