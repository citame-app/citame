use chrono::Datelike;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{CoreError, Result};
use crate::inventory::{Pagination, Product};
use crate::purchase_orders::{
    PURCHASE_ORDER_WRITE, PurchaseOrder, PurchaseOrderLink, PurchaseOrderProposal,
};
use crate::trim_like_javascript;

pub const SUPPLIER_SAVE: &str = "supplier.save";
pub const RECEIVE_STOCK: &str = "stock.receipt";
pub const MAX_LINES: usize = 50;
pub(crate) const MAX_STOCK: u32 = 999_999_999;

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupplierFields {
    pub name: String,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub tax_id: Option<String>,
    pub notes: Option<String>,
    pub active: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Supplier {
    pub id: Uuid,
    pub version: u32,
    #[serde(flatten)]
    pub fields: SupplierFields,
}

impl Supplier {
    pub fn new() -> Self {
        Self {
            id: Uuid::now_v7(),
            version: 0,
            fields: SupplierFields {
                active: true,
                ..Default::default()
            },
        }
    }

    pub fn matches_search(&self, term: &str) -> bool {
        [
            Some(self.fields.name.as_str()),
            self.fields.email.as_deref(),
            self.fields.tax_id.as_deref(),
            self.fields.phone.as_deref(),
        ]
        .into_iter()
        .flatten()
        .any(|value| value.to_lowercase().contains(term))
    }

    pub(crate) fn normalized(mut self) -> Result<Self> {
        self.fields.name = trim_like_javascript(&self.fields.name).into();
        if self.fields.name.is_empty() || self.version >= i32::MAX as u32 {
            return Err(invalid());
        }
        valid_text(&self.fields.name, 160)?;
        self.fields.email = clean_text(self.fields.email, 254)?;
        self.fields.phone = clean_text(self.fields.phone, 50)?;
        self.fields.tax_id = clean_text(self.fields.tax_id, 50)?;
        self.fields.notes = clean_text(self.fields.notes, 1000)?;
        if self.fields.email.as_ref().is_some_and(|address| {
            let Some((mailbox, host)) = address.split_once('@') else {
                return true;
            };
            mailbox.is_empty() || !host.contains('.') || address.chars().any(char::is_whitespace)
        }) {
            return Err(invalid());
        }
        Ok(self)
    }
}

impl Default for Supplier {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SupplierPage {
    pub suppliers: Vec<Supplier>,
    pub pagination: Pagination,
    pub generation: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptHeader {
    pub id: Uuid,
    pub number: u32,
    pub received_on: String,
    pub supplier_id: Option<Uuid>,
    pub supplier_name: Option<String>,
    pub invoice_reference: Option<String>,
    pub notes: Option<String>,
    pub line_count: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warehouse_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warehouse_name: Option<String>,
    #[serde(default)]
    pub warehouse_confirmed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub purchase_order_id: Option<Uuid>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptLine {
    pub product_id: Uuid,
    pub name: String,
    pub sku: String,
    pub quantity: u32,
    pub unit_cost_cents: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Receipt {
    #[serde(flatten)]
    pub header: ReceiptHeader,
    pub lines: Vec<ReceiptLine>,
}

impl Receipt {
    pub fn matches_delivery(&self, proposed: &Delivery) -> bool {
        self.header.id == proposed.id
            && self.header.warehouse_confirmed
            && self.header.warehouse_id == proposed.warehouse_id
            && self.header.supplier_id == proposed.supplier_id
            && self.header.purchase_order_id == proposed.purchase_order.map(|order| order.id)
            && self.header.received_on == proposed.received_on
            && self.header.invoice_reference == proposed.invoice_reference
            && self.header.notes == proposed.notes
            && self.lines.len() == proposed.lines.len()
            && proposed.lines.iter().all(|planned| {
                self.lines.iter().any(|recorded| {
                    planned.product_id == recorded.product_id
                        && planned.quantity == recorded.quantity
                })
            })
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ReceiptPage {
    pub receipts: Vec<ReceiptHeader>,
    pub pagination: Pagination,
}

#[derive(Debug, Deserialize)]
pub struct ReviewedDocument<T> {
    pub generation: String,
    #[serde(flatten)]
    pub value: T,
}

pub enum DeliveryReview {
    Recorded(ReviewedDocument<Receipt>),
    Current {
        products: Vec<Option<Product>>,
        supplier: Option<ReviewedDocument<Supplier>>,
        order: Option<Box<ReviewedDocument<PurchaseOrder>>>,
        warehouses: Option<crate::warehouses::WarehouseList>,
    },
}

#[derive(Clone)]
pub struct DeliveryReviewRequest {
    pub id: Uuid,
    pub supplier_id: Option<Uuid>,
    pub product_ids: Vec<Uuid>,
    pub purchase_order: Option<PurchaseOrderLink>,
    pub warehouse_id: Option<Uuid>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryLine {
    pub product_id: Uuid,
    pub quantity: u32,
    pub version: u32,
}

impl DeliveryLine {
    pub fn reviewed(product: &Product, quantity: &str, generation: &str) -> Result<Self> {
        Self::reviewed_for_delivery(product, quantity, generation, false)
    }

    pub fn reviewed_for_delivery(
        product: &Product,
        quantity: &str,
        generation: &str,
        linked: bool,
    ) -> Result<Self> {
        let quantity: u32 = trim_like_javascript(quantity)
            .parse()
            .map_err(|_| invalid())?;
        let line = Self {
            product_id: product.id,
            quantity,
            version: product.version,
        };
        if !line.matches_review(product, generation, linked) {
            return Err(invalid());
        }
        Ok(line)
    }

    pub(crate) fn matches_review(&self, product: &Product, generation: &str, linked: bool) -> bool {
        product.id == self.product_id
            && product.version == self.version
            && (product.active || linked)
            && product.can_manage
            && product.inventory_generation.as_deref() == Some(generation)
            && self.quantity > 0
            && self.quantity <= MAX_STOCK.saturating_sub(product.stock_on_hand)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Delivery {
    pub id: Uuid,
    pub received_on: String,
    pub supplier_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warehouse_id: Option<Uuid>,
    pub invoice_reference: Option<String>,
    pub notes: Option<String>,
    pub actor_user_id: String,
    pub lines: Vec<DeliveryLine>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub purchase_order: Option<PurchaseOrderLink>,
}

impl Delivery {
    pub(crate) fn normalized(mut self) -> Result<Self> {
        self.received_on = trim_like_javascript(&self.received_on).into();
        let parsed: chrono::NaiveDate = self.received_on.parse().map_err(|_| invalid())?;
        let distinct = self
            .lines
            .iter()
            .map(|line| line.product_id)
            .collect::<std::collections::BTreeSet<_>>();
        if self.received_on != parsed.to_string()
            || self.received_on.len() != 10
            || parsed.year() < 1
            || self.purchase_order.is_some_and(|order| {
                order.version == 0 || order.version >= i32::MAX as u32 || self.supplier_id.is_none()
            })
            || self.actor_user_id.is_empty()
            || self.actor_user_id.encode_utf16().count() > 200
            || !(1..=MAX_LINES).contains(&self.lines.len())
            || distinct.len() != self.lines.len()
            || self
                .lines
                .iter()
                .any(|line| line.quantity == 0 || line.quantity > MAX_STOCK || line.version == 0)
        {
            return Err(invalid());
        }
        self.invoice_reference = clean_text(self.invoice_reference, 100)?;
        self.notes = clean_text(self.notes, 1000)?;
        Ok(self)
    }
}

#[derive(Clone, Debug)]
pub enum DocumentProposal {
    Supplier(Supplier),
    Receipt(Delivery),
    PurchaseOrder(PurchaseOrderProposal),
}

impl DocumentProposal {
    pub fn id(&self) -> Uuid {
        match self {
            Self::Supplier(row) => row.id,
            Self::Receipt(row) => row.id,
            Self::PurchaseOrder(row) => row.id,
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Self::Supplier(_) => SUPPLIER_SAVE,
            Self::Receipt(_) => RECEIVE_STOCK,
            Self::PurchaseOrder(_) => PURCHASE_ORDER_WRITE,
        }
    }

    pub(crate) fn payload(self) -> Result<serde_json::Value> {
        Ok(match self {
            Self::Supplier(row) => serde_json::to_value(row.normalized()?)?,
            Self::Receipt(row) => serde_json::to_value(row.normalized()?)?,
            Self::PurchaseOrder(row) => serde_json::to_value(row.normalized()?)?,
        })
    }

    pub(crate) fn from_payload(kind: &str, payload: serde_json::Value) -> Result<Self> {
        match kind {
            SUPPLIER_SAVE => Ok(Self::Supplier(serde_json::from_value(payload)?)),
            RECEIVE_STOCK => Ok(Self::Receipt(serde_json::from_value(payload)?)),
            PURCHASE_ORDER_WRITE => Ok(Self::PurchaseOrder(serde_json::from_value(payload)?)),
            _ => Err(invalid()),
        }
    }
}

pub(crate) fn invalid() -> CoreError {
    CoreError::Invalid("Invalid inventory document fields".into())
}

fn valid_text(value: &str, max: usize) -> Result<()> {
    if value.contains('\0') || value.encode_utf16().count() > max {
        return Err(invalid());
    }
    Ok(())
}

pub(crate) fn clean_text(value: Option<String>, max: usize) -> Result<Option<String>> {
    let value = value
        .map(|text| trim_like_javascript(&text).to_owned())
        .filter(|text| !text.is_empty());
    if let Some(text) = &value {
        valid_text(text, max)?;
    }
    Ok(value)
}
