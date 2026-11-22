use super::*;
use serde::Deserialize;

const PATH: &str = "/admin/settings/inventory-numbering";
pub const INVENTORY_NUMBER_MAX: u32 = i32::MAX as u32;

#[derive(Clone, Copy)]
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

impl InventoryNumberingSnapshot {
    pub fn series(&self, series: InventoryNumberingSeries) -> &InventoryNumberingState {
        match series {
            InventoryNumberingSeries::Orders => &self.orders,
            InventoryNumberingSeries::Receipts => &self.receipts,
        }
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
        series: InventoryNumberingSeries,
        generation: &str,
        expected: u32,
        next: u32,
    ) -> Result<InventoryNumberingState, TransportError> {
        self.put_json(
            &format!("{PATH}/{}", series.path()),
            &serde_json::json!({
                "generation": generation, "expectedNextNumber": expected, "nextNumber": next,
            }),
        )
    }
}
