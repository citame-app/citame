//! Inventory catalog and product metadata served by Citame's inventory API.

use crate::sync::TransportError;
use serde::{Deserialize, Serialize};
use url::form_urlencoded;
use uuid::Uuid;

pub const LIVE_TOPIC: &str = "commerce";
pub const MAX_PAGE: u32 = 100_000;
pub const PRODUCTS_PATH: &str = "/admin/inventory/products";
const LEDGER_PATH: &str = "/admin/inventory/movements";
pub type ProductId = Uuid;
pub type StockRequestId = Uuid;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StockReturnAttempt {
    pub(crate) product_id: Uuid,
    pub(crate) receipt_id: Uuid,
    pub(crate) command: StockReturnCommand,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StockReturnCommand {
    pub(crate) actor_user_id: String,
    pub(crate) checkout_line_id: Uuid,
    pub(crate) quantity: u32,
    pub(crate) reason: String,
    pub(crate) generation: String,
    pub(crate) idempotency_key: StockRequestId,
}

impl StockReturnAttempt {
    pub fn valid_input(quantity: u32, maximum: u32, reason: &str) -> bool {
        (1..=maximum).contains(&quantity)
            && (3..=300).contains(&reason.trim().encode_utf16().count())
    }

    pub fn reason(&self) -> &str {
        &self.command.reason
    }

    pub fn line_id(&self) -> Uuid {
        self.command.checkout_line_id
    }

    pub fn quantity(&self) -> u32 {
        self.command.quantity
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ProductActivity {
    #[default]
    Active,
    Archived,
    All,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ProductSort {
    #[default]
    NameAscending,
    NameDescending,
    Updated,
    Stock,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ProductPageSize {
    #[default]
    Twenty,
    Fifty,
    Hundred,
}

impl ProductPageSize {
    pub const fn number(self) -> u32 {
        match self {
            Self::Twenty => 20,
            Self::Fifty => 50,
            Self::Hundred => 100,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProductQuery {
    pub search: String,
    pub activity: ProductActivity,
    pub category: Option<String>,
    pub brand: Option<String>,
    pub subcategory_id: Option<Uuid>,
    pub resellable: Option<bool>,
    pub low_stock: bool,
    pub sort: ProductSort,
    pub page_size: ProductPageSize,
}

impl ProductQuery {
    pub fn new(search: &str, include_archived: bool) -> Option<Self> {
        let query = Self {
            activity: if include_archived {
                ProductActivity::All
            } else {
                ProductActivity::Active
            },
            ..Self::default()
        };
        query.with_search(search)
    }

    pub fn with_search(mut self, search: &str) -> Option<Self> {
        let search = crate::trim_like_javascript(search);
        if search.encode_utf16().count() > 100 || search.contains('\0') {
            return None;
        }
        self.search = search.to_owned();
        Some(self)
    }

    fn parameters(&self, ordered: bool) -> String {
        let mut query = form_urlencoded::Serializer::new(String::new());
        query.append_pair("search", &self.search).append_pair(
            "active",
            match self.activity {
                ProductActivity::Active => "active",
                ProductActivity::Archived => "inactive",
                ProductActivity::All => "all",
            },
        );
        if let Some(category) = &self.category {
            query.append_pair("category", category);
        }
        if let Some(subcategory) = self.subcategory_id {
            query.append_pair("subcategoryId", &subcategory.to_string());
        }
        if let Some(brand) = &self.brand {
            query.append_pair("brand", brand);
        }
        if let Some(resellable) = self.resellable {
            query.append_pair("resellable", if resellable { "true" } else { "false" });
        }
        if self.low_stock {
            query.append_pair("lowStock", "true");
        }
        if ordered {
            query.append_pair(
                "sort",
                match self.sort {
                    ProductSort::NameAscending => "name_asc",
                    ProductSort::NameDescending => "name_desc",
                    ProductSort::Updated => "updated_desc",
                    ProductSort::Stock => "stock_asc",
                },
            );
        }
        query.finish()
    }

    pub(crate) fn path(&self, page: u32) -> String {
        format!(
            "{PRODUCTS_PATH}?{}&page={page}&pageSize={}",
            self.parameters(true),
            self.page_size.number()
        )
    }

    pub(crate) fn export_path(&self) -> String {
        format!("{PRODUCTS_PATH}/export?{}", self.parameters(true))
    }

    pub(crate) fn report_path(&self) -> String {
        format!("{PRODUCTS_PATH}/report?{}", self.parameters(false))
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryReport {
    pub products: u64,
    pub on_hand: u64,
    pub reserved: u64,
    pub low_stock_products: u64,
    pub valuation: Option<InventoryValuation>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryValuation {
    pub currency: String,
    pub known_cost_cents: String,
    pub products_missing_cost: u64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct InventoryFacets {
    pub categories: Vec<String>,
    pub brands: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LedgerKind {
    Movement(StockKind),
    Transfer,
}

impl LedgerKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Movement(kind) => kind.as_str(),
            Self::Transfer => "transfer",
        }
    }

    fn includes(self, movement: &StockMovement) -> bool {
        match self {
            Self::Transfer => movement.transfer_id.is_some(),
            Self::Movement(kind) => movement.transfer_id.is_none() && movement.kind == kind,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LedgerQuery {
    search: String,
    pub kind: Option<LedgerKind>,
    pub warehouse: Option<crate::warehouses::WarehouseLocation>,
    pub anchor: Option<String>,
}

impl LedgerQuery {
    pub fn new(search: &str, kind: Option<LedgerKind>) -> Option<Self> {
        let search = trim_form_value(search);
        (search.encode_utf16().count() <= 100 && !search.contains('\0')).then(|| Self {
            search: search.to_owned(),
            kind,
            warehouse: None,
            anchor: None,
        })
    }

    pub(crate) fn includes(&self, movement: &StockMovement) -> bool {
        self.kind.is_none_or(|kind| kind.includes(movement))
            && self
                .warehouse
                .is_none_or(|warehouse| movement.warehouse_id == warehouse.0)
    }

    fn filters(&self) -> String {
        let mut query = form_urlencoded::Serializer::new(String::new());
        query.append_pair("search", &self.search);
        if let Some(kind) = self.kind {
            query.append_pair("kind", kind.as_str());
        }
        if let Some(warehouse) = self.warehouse {
            query.append_pair("warehouseId", &String::from(warehouse));
        }
        if let Some(anchor) = &self.anchor {
            query.append_pair("anchor", anchor);
        }
        query.finish()
    }

    pub(crate) fn list_path(&self, page: u32) -> String {
        format!("{LEDGER_PATH}?{}&page={page}", self.filters())
    }

    pub(crate) fn export_path(&self) -> String {
        format!("{LEDGER_PATH}/export?{}", self.filters())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackageContent {
    pub quantity: String,
    pub unit: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InvalidPackageContent;

#[derive(Debug, thiserror::Error)]
pub enum ContentWriteError {
    #[error("Another session changed this product")]
    Conflict,
    #[error(transparent)]
    Transport(#[from] TransportError),
}

fn trim_form_value(value: &str) -> &str {
    value.trim_matches(|c: char| (c.is_whitespace() && c != '\u{0085}') || c == '\u{feff}')
}

impl PackageContent {
    pub fn parse(quantity: &str, unit: &str) -> Result<Option<Self>, InvalidPackageContent> {
        let (quantity, unit) = (trim_form_value(quantity), trim_form_value(unit));
        if quantity.is_empty() && unit.is_empty() {
            return Ok(None);
        }
        let normalized = quantity.replace(',', ".");
        let (integer, fraction) = normalized.split_once('.').unwrap_or((&normalized, ""));
        if !(1..=9).contains(&integer.len())
            || !integer.bytes().all(|b| b.is_ascii_digit())
            || (normalized.contains('.') && !(1..=3).contains(&fraction.len()))
            || !fraction.bytes().all(|b| b.is_ascii_digit())
            || !(1..=20).contains(&unit.encode_utf16().count())
            || unit.contains('\0')
        {
            return Err(InvalidPackageContent);
        }
        let integer = integer.trim_start_matches('0');
        let fraction = fraction.trim_end_matches('0');
        let quantity = match (integer, fraction) {
            ("", "") => return Err(InvalidPackageContent),
            (integer, "") => integer.to_owned(),
            ("", fraction) => format!("0.{fraction}"),
            _ => format!("{integer}.{fraction}"),
        };
        Ok(Some(Self {
            quantity,
            unit: unit.to_owned(),
        }))
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Product {
    pub id: ProductId,
    pub name: String,
    pub photo_version: Option<Uuid>,
    pub sku: String,
    pub barcode: Option<String>,
    pub category: Option<String>,
    pub brand: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub classification: Option<crate::inventory_classifications::ClassificationAssignment>,
    pub description: Option<String>,
    pub storage_location: Option<String>,
    pub stock_on_hand: u32,
    pub stock_reserved: u32,
    #[serde(default)]
    pub stock_allocated: u32,
    pub available: u32,
    pub sellable_available: Option<u32>,
    pub unit_label: String,
    pub package_content: Option<PackageContent>,
    pub price_cents: i64,
    pub cost_cents: Option<i64>,
    #[serde(default)]
    pub tax_basis_points: u32,
    #[serde(default)]
    pub resellable: bool,
    pub target_stock: Option<u32>,
    #[serde(default)]
    pub low_stock_threshold: u32,
    #[serde(default)]
    pub low_stock: bool,
    pub currency: String,
    pub active: bool,
    pub version: u32,
    pub inventory_generation: Option<String>,
    #[serde(default)]
    pub can_manage: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductPage {
    pub products: Vec<Product>,
    pub pagination: Pagination,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StockKind {
    Opening,
    #[default]
    Receive,
    Consume,
    Count,
    Sale,
    Return,
}

impl StockKind {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Opening => "opening",
            Self::Receive => "receive",
            Self::Consume => "consume",
            Self::Count => "count",
            Self::Sale => "sale",
            Self::Return => "return",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StockMovement {
    pub id: Uuid,
    pub product_id: ProductId,
    pub kind: StockKind,
    pub quantity_delta: i64,
    pub reason: String,
    pub receipt_id: Option<Uuid>,
    pub warehouse_id: Option<Uuid>,
    pub warehouse_name: Option<String>,
    pub transfer_id: Option<Uuid>,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MovementPage {
    pub movements: Vec<StockMovement>,
    pub pagination: Pagination,
    pub inventory_generation: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerMovement {
    #[serde(flatten)]
    pub movement: StockMovement,
    pub product_name: String,
    pub sku: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerPage {
    pub movements: Vec<LedgerMovement>,
    pub pagination: Pagination,
    pub anchor: Option<String>,
    #[serde(default)]
    pub has_newer: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StockCommand {
    pub kind: StockKind,
    pub quantity: u32,
    pub reason: String,
    pub version: u32,
    pub generation: String,
    pub idempotency_key: StockRequestId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warehouse_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingStock {
    pub product_id: ProductId,
    pub command: StockCommand,
}

impl PendingStock {
    pub fn prepare(
        product: &Product,
        kind: StockKind,
        quantity: &str,
        reason: &str,
    ) -> Option<Self> {
        let quantity = trim_form_value(quantity);
        if !quantity.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        let quantity = quantity.parse::<u32>().ok()?;
        let reason = trim_form_value(reason);
        let physical = match kind {
            StockKind::Receive if quantity > 0 => product.stock_on_hand.checked_add(quantity)?,
            StockKind::Consume if quantity > 0 => product.stock_on_hand.checked_sub(quantity)?,
            StockKind::Count => quantity.checked_add(product.stock_allocated)?,
            _ => return None,
        };
        if !product.can_manage
            || !(product
                .stock_reserved
                .saturating_add(product.stock_allocated)..=999_999_999)
                .contains(&physical)
            || !(3..=300).contains(&reason.encode_utf16().count())
            || reason.contains('\0')
        {
            return None;
        }
        Some(Self {
            product_id: product.id,
            command: StockCommand {
                kind,
                quantity,
                reason: reason.into(),
                version: product.version,
                generation: product.inventory_generation.clone()?,
                idempotency_key: Uuid::now_v7(),
                warehouse_id: (kind == StockKind::Count && product.stock_allocated > 0)
                    .then(|| "main".to_owned()),
            },
        })
    }
}

#[derive(Debug, thiserror::Error)]
pub enum StockWriteError {
    #[error("The product changed before the movement was recorded")]
    Conflict,
    #[error("The movement could not be applied")]
    Rejected,
    #[error(transparent)]
    Transport(#[from] TransportError),
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pagination {
    pub page: u32,
    pub page_size: u32,
    pub total: u64,
}

impl Pagination {
    pub fn has_next(&self) -> bool {
        self.page < MAX_PAGE && u64::from(self.page) * u64::from(self.page_size) < self.total
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn product_export_shares_filters_and_order_without_page_limits() {
        let mut query = ProductQuery::new("kit & foil", false).unwrap();
        query.category = Some("Manos / Pies".into());
        query.brand = Some("Marca +".into());
        query.resellable = Some(false);
        query.activity = ProductActivity::Archived;
        query.low_stock = true;
        query.sort = ProductSort::Stock;
        query.page_size = ProductPageSize::Hundred;
        let export = query.export_path();
        let list = query.path(4);
        let params = export.split_once('?').unwrap().1;
        assert_eq!(
            params,
            "search=kit+%26+foil&active=inactive&category=Manos+%2F+Pies&brand=Marca+%2B&resellable=false&lowStock=true&sort=stock_asc"
        );
        assert_eq!(
            list,
            format!("{PRODUCTS_PATH}?{params}&page=4&pageSize=100")
        );
        assert!(!query.report_path().contains("sort"));
    }

    #[test]
    fn package_content_validates_like_the_web_contract() {
        assert_eq!(PackageContent::parse("", "   "), Ok(None));
        assert_eq!(
            PackageContent::parse("00012,500", " ml ").unwrap().unwrap(),
            PackageContent {
                quantity: "12.5".into(),
                unit: "ml".into()
            }
        );
        assert_eq!(
            PackageContent::parse("0,001", "L")
                .unwrap()
                .unwrap()
                .quantity,
            "0.001"
        );
        for (quantity, unit) in [
            ("0.0", "ml"),
            ("12.", "ml"),
            ("0.0001", "ml"),
            ("1.2,3", "ml"),
            ("12", ""),
            ("12", "m\0l"),
            ("1000000000", "ml"),
        ] {
            assert_eq!(
                PackageContent::parse(quantity, unit),
                Err(InvalidPackageContent)
            );
        }
    }

    #[test]
    fn search_encodes_full_terms_and_rejects_overlong_input() {
        assert!(ProductQuery::new(&"🧴".repeat(51), false).is_none());
        let query = ProductQuery::new("  A&B / 2  ", true).unwrap();
        assert_eq!(
            query.path(2),
            "/admin/inventory/products?search=A%26B+%2F+2&active=all&sort=name_asc&page=2&pageSize=20"
        );
    }

    #[test]
    fn ledger_list_and_export_use_the_same_filters_without_limiting_the_csv_page() {
        let mut filter = LedgerQuery::new(
            "  A&B / 2  ",
            Some(LedgerKind::Movement(StockKind::Receive)),
        )
        .unwrap();
        assert_eq!(
            filter.list_path(3),
            "/admin/inventory/movements?search=A%26B+%2F+2&kind=receive&page=3"
        );
        assert_eq!(
            filter.export_path(),
            "/admin/inventory/movements/export?search=A%26B+%2F+2&kind=receive"
        );
        filter.kind = Some(LedgerKind::Transfer);
        filter.warehouse = Some(crate::warehouses::WarehouseLocation(None));
        filter.anchor = Some("revision:12".into());
        let expected = "search=A%26B+%2F+2&kind=transfer&warehouseId=main&anchor=revision%3A12";
        assert_eq!(
            filter.list_path(2),
            format!("/admin/inventory/movements?{expected}&page=2")
        );
        assert_eq!(
            filter.export_path(),
            format!("/admin/inventory/movements/export?{expected}")
        );
        assert!(LedgerQuery::new(&"🧴".repeat(51), None).is_none());
    }
}
