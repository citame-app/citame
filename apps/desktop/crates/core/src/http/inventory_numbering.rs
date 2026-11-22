use super::*;
use serde::Deserialize;

const PATH: &str = "/admin/settings/inventory-numbering";
pub const INVENTORY_NUMBER_MAX: u32 = i32::MAX as u32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InventoryNumberingSeries {
    Orders,
    Receipts,
}

impl InventoryNumberingSeries {
    fn path(self) -> &'static str {
        match self {
            Self::Orders => "orders",
            Self::Receipts => "receipts",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryNumberingState {
    pub next_number: Option<u32>,
    pub last_issued_number: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct InventoryNumberingSnapshot {
    pub generation: String,
    pub orders: InventoryNumberingState,
    pub receipts: InventoryNumberingState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewedInventorySeries {
    pub series: InventoryNumberingSeries,
    generation: String,
    next_number: u32,
}

impl ReviewedInventorySeries {
    pub fn candidate(&self, text: &str) -> Option<u32> {
        if !text.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        text.parse::<u32>()
            .ok()
            .filter(|number| *number >= self.next_number && *number <= INVENTORY_NUMBER_MAX)
    }
}

impl InventoryNumberingSnapshot {
    pub fn series(&self, series: InventoryNumberingSeries) -> &InventoryNumberingState {
        match series {
            InventoryNumberingSeries::Orders => &self.orders,
            InventoryNumberingSeries::Receipts => &self.receipts,
        }
    }

    pub fn review(&self, series: InventoryNumberingSeries) -> Option<ReviewedInventorySeries> {
        Some(ReviewedInventorySeries {
            series,
            generation: self.generation.clone(),
            next_number: self.series(series).next_number?,
        })
    }

    pub fn set_series(&mut self, series: InventoryNumberingSeries, state: InventoryNumberingState) {
        match series {
            InventoryNumberingSeries::Orders => self.orders = state,
            InventoryNumberingSeries::Receipts => self.receipts = state,
        }
    }
}

impl HttpTransport {
    pub fn inventory_numbering(&self) -> Result<InventoryNumberingSnapshot, TransportError> {
        read_response(self.get(&self.agent, PATH, None)?, false)
    }

    pub fn advance_inventory_numbering(
        &self,
        base: &ReviewedInventorySeries,
        next: u32,
    ) -> Result<InventoryNumberingState, TransportError> {
        self.put_json(
            &format!("{PATH}/{}", base.series.path()),
            &serde_json::json!({
                "generation": base.generation, "expectedNextNumber": base.next_number, "nextNumber": next,
            }),
        )
    }
}
