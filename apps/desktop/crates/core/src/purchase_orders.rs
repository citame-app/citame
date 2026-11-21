use std::collections::BTreeSet;

use chrono::{Datelike, NaiveDate};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::Result;
use crate::inventory::Pagination;
use crate::inventory_documents::{MAX_LINES, MAX_STOCK, clean_text, invalid};

pub const PURCHASE_ORDER_WRITE: &str = "purchase_order.write";

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PurchaseOrderStatus {
    Draft,
    Ordered,
    PartiallyReceived,
    Received,
    Cancelled,
}

impl PurchaseOrderStatus {
    pub fn allows_delivery(self) -> bool {
        matches!(self, Self::Ordered | Self::PartiallyReceived)
    }

    pub fn allows_cancel(self) -> bool {
        self == Self::Draft || self.allows_delivery()
    }

    pub fn query_value(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Ordered => "ordered",
            Self::PartiallyReceived => "partially_received",
            Self::Received => "received",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseOrderHeader {
    pub id: Uuid,
    pub number: u32,
    pub status: PurchaseOrderStatus,
    pub version: u32,
    pub supplier_id: Uuid,
    pub supplier_name: String,
    pub supplier_reference: Option<String>,
    pub expected_on: Option<String>,
    pub notes: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseOrderLine {
    pub product_id: Uuid,
    pub name: String,
    pub sku: String,
    pub quantity: u32,
    pub received_quantity: u32,
}

impl PurchaseOrderLine {
    pub fn remaining(&self) -> u32 {
        self.quantity.saturating_sub(self.received_quantity)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedReceipt {
    pub id: Uuid,
    pub number: u32,
    pub received_on: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PurchaseOrder {
    #[serde(flatten)]
    pub header: PurchaseOrderHeader,
    pub lines: Vec<PurchaseOrderLine>,
    pub receipts: Vec<LinkedReceipt>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PurchaseOrderPage {
    pub orders: Vec<PurchaseOrderHeader>,
    pub pagination: Pagination,
    pub generation: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct PurchaseOrderLink {
    pub id: Uuid,
    pub version: u32,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestedProduct {
    pub product_id: Uuid,
    pub quantity: u32,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseOrderFields {
    pub supplier_id: Uuid,
    pub supplier_reference: Option<String>,
    pub expected_on: Option<String>,
    pub notes: Option<String>,
    pub lines: Vec<RequestedProduct>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum PurchaseOrderAction {
    Save(PurchaseOrderFields),
    Order,
    Cancel,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PurchaseOrderProposal {
    pub id: Uuid,
    pub version: u32,
    #[serde(flatten)]
    pub action: PurchaseOrderAction,
}

impl PurchaseOrderProposal {
    pub(crate) fn normalized(mut self) -> Result<Self> {
        if self.version >= i32::MAX as u32
            || (self.version == 0 && !matches!(self.action, PurchaseOrderAction::Save(_)))
        {
            return Err(invalid());
        }
        if let PurchaseOrderAction::Save(fields) = &mut self.action {
            fields.supplier_reference = clean_text(fields.supplier_reference.take(), 100)?;
            fields.expected_on = clean_text(fields.expected_on.take(), 10)?;
            fields.notes = clean_text(fields.notes.take(), 1000)?;
            if let Some(expected) = fields.expected_on.as_deref() {
                let day: NaiveDate = expected.parse().map_err(|_| invalid())?;
                if day.year() < 1 || expected.len() != 10 || day.to_string() != expected {
                    return Err(invalid());
                }
            }
            let mut products = BTreeSet::new();
            if !(1..=MAX_LINES).contains(&fields.lines.len())
                || fields.lines.iter().any(|line| {
                    !(1..=MAX_STOCK).contains(&line.quantity) || !products.insert(line.product_id)
                })
            {
                return Err(invalid());
            }
        }
        Ok(self)
    }
}
