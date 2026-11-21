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
    Adjustment(WarehouseAdjustment),
}

pub const ADJUST: &str = "warehouse.adjust";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(try_from = "String", into = "String")]
pub struct WarehouseLocation(pub Option<Uuid>);

impl TryFrom<String> for WarehouseLocation {
    type Error = uuid::Error;

    fn try_from(key: String) -> Result<Self, Self::Error> {
        if key == "main" {
            return Ok(Self(None));
        }
        Ok(Self(Some(key.parse()?)))
    }
}

impl From<WarehouseLocation> for String {
    fn from(location: WarehouseLocation) -> Self {
        location_key(location.0)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WarehouseAdjustment {
    pub id: Uuid,
    pub warehouse_id: WarehouseLocation,
    pub product_id: Uuid,
    pub kind: crate::inventory::StockKind,
    pub quantity: u32,
    pub version: u32,
    pub reviewed_on_hand: u32,
    pub reason: String,
}

impl WarehouseAdjustment {
    pub(crate) fn normalize(&mut self) -> bool {
        use crate::inventory::StockKind;
        self.reason = crate::trim_like_javascript(&self.reason).to_owned();
        let allowed_kind = match self.kind {
            StockKind::Receive | StockKind::Consume => self.quantity > 0,
            StockKind::Count => true,
            _ => false,
        };
        allowed_kind
            && self.quantity <= 999_999_999
            && (3..=300).contains(&self.reason.encode_utf16().count())
            && !self.reason.contains('\0')
    }

    pub(crate) fn matches_balance(&self, balance: &WarehouseBalance) -> bool {
        self.product_id == balance.product_id
            && self.version == balance.version
            && self.reviewed_on_hand == balance.on_hand
    }

    pub(crate) fn fits(&self, balance: &WarehouseBalance) -> bool {
        use crate::inventory::StockKind;
        match self.kind {
            StockKind::Receive => balance
                .on_hand
                .checked_add(self.quantity)
                .is_some_and(|next| next <= 999_999_999),
            StockKind::Consume => balance.available() >= self.quantity,
            StockKind::Count => self.quantity >= balance.reserved,
            _ => false,
        }
    }

    pub fn matches(&self, recorded: &RecordedAdjustment) -> bool {
        let row = &recorded.movement;
        row.id == self.id
            && row.product_id == self.product_id
            && row.warehouse_id == self.warehouse_id.0
            && row.kind == self.kind
            && row.reason == self.reason
            && recorded.review.version == self.version
            && recorded.review.on_hand == self.reviewed_on_hand
            && recorded.review.quantity == self.quantity
    }
}

#[derive(Debug, Deserialize)]
pub struct RecordedAdjustment {
    #[serde(flatten)]
    pub movement: crate::inventory::StockMovement,
    pub review: AdjustmentReview,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdjustmentReview {
    pub version: u32,
    pub on_hand: u32,
    pub quantity: u32,
}
