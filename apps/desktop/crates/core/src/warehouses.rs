use crate::inventory::Pagination;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const SAVE: &str = "warehouse.save";
pub const TRANSFER: &str = "warehouse.transfer";

pub(crate) fn location_key(id: Option<Uuid>) -> String {
    id.map_or_else(|| "main".into(), |id| id.to_string())
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Warehouse {
    pub id: Option<Uuid>,
    pub name: Option<String>,
    pub active: bool,
    pub version: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct WarehouseList {
    pub warehouses: Vec<Warehouse>,
    pub generation: String,
}

impl WarehouseList {
    pub fn has_active_location(&self, id: Option<Uuid>) -> bool {
        self.warehouses.iter().any(|row| row.id == id && row.active)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WarehouseBalance {
    pub product_id: Uuid,
    pub sku: String,
    pub name: String,
    pub version: u32,
    pub on_hand: u32,
    pub reserved: u32,
}

impl WarehouseBalance {
    pub fn available(&self) -> u32 {
        self.on_hand.saturating_sub(self.reserved)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct WarehouseStock {
    pub warehouse: Warehouse,
    pub products: Vec<WarehouseBalance>,
    pub generation: String,
    pub pagination: Pagination,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct WarehouseEdit {
    pub id: Uuid,
    pub name: String,
    pub version: u32,
    pub active: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferLine {
    pub product_id: Uuid,
    pub quantity: u32,
    pub version: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WarehouseTransfer {
    pub id: Uuid,
    pub source_id: Option<Uuid>,
    pub destination_id: Option<Uuid>,
    pub reason: String,
    pub lines: Vec<TransferLine>,
}

impl WarehouseEdit {
    pub(crate) fn normalize(&mut self) -> bool {
        self.name = crate::trim_like_javascript(&self.name).to_owned();
        !self.name.is_empty()
            && self.name.encode_utf16().count() <= 100
            && !self.name.contains('\0')
    }
}

impl WarehouseTransfer {
    pub(crate) fn normalize(&mut self) -> bool {
        self.reason = crate::trim_like_javascript(&self.reason).to_owned();
        self.source_id != self.destination_id
            && !self.reason.is_empty()
            && self.reason.encode_utf16().count() <= 300
            && !self.reason.contains('\0')
            && (1..=50).contains(&self.lines.len())
            && self
                .lines
                .iter()
                .all(|line| (1..=999_999_999).contains(&line.quantity))
            && self
                .lines
                .iter()
                .map(|line| line.product_id)
                .collect::<std::collections::HashSet<_>>()
                .len()
                == self.lines.len()
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedWarehouseTransfer {
    pub id: Uuid,
    pub source_id: Option<Uuid>,
    pub source_name: Option<String>,
    pub destination_id: Option<Uuid>,
    pub destination_name: Option<String>,
    pub reason: String,
    pub lines: Vec<RecordedTransferLine>,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedTransferLine {
    pub product_id: Uuid,
    pub sku: String,
    pub name: String,
    pub quantity: u32,
}

impl RecordedWarehouseTransfer {
    pub fn matches(&self, proposed: &WarehouseTransfer) -> bool {
        self.id == proposed.id
            && self.source_id == proposed.source_id
            && self.destination_id == proposed.destination_id
            && self.reason == proposed.reason
            && self.lines.len() == proposed.lines.len()
            && proposed.lines.iter().all(|planned| {
                self.lines.iter().any(|recorded| {
                    planned.product_id == recorded.product_id
                        && planned.quantity == recorded.quantity
                })
            })
    }
}

pub enum PendingWarehouseChange {
    Edit(WarehouseEdit),
    Transfer(WarehouseTransfer),
}
