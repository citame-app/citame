use crate::billing::parse_reviewed_amount;
use crate::inventory::{PackageContent, Product, ProductId};
use crate::{error::*, trim_like_javascript};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const CREATE: &str = "product.create";
pub const UPDATE: &str = "product.update";
pub const PHOTO: &str = "product.photo";
pub(crate) const ACCESS: &str = "inventory_write_access";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductDraft {
    pub name: String,
    pub sku: Option<String>,
    pub barcode: Option<String>,
    pub category: Option<String>,
    pub brand: Option<String>,
    pub description: Option<String>,
    pub storage_location: Option<String>,
    pub unit_label: String,
    pub package_content: Option<PackageContent>,
    pub price_cents: u32,
    pub cost_cents: Option<u32>,
    pub tax_basis_points: u32,
    pub low_stock_threshold: u32,
    pub target_stock: Option<u32>,
    pub opening_stock: u32,
    pub resellable: bool,
    pub active: bool,
}

impl Default for ProductDraft {
    fn default() -> Self {
        Self {
            name: String::new(),
            sku: None,
            barcode: None,
            category: None,
            brand: None,
            description: None,
            storage_location: None,
            unit_label: "unit".into(),
            package_content: None,
            price_cents: 0,
            cost_cents: None,
            tax_basis_points: 0,
            low_stock_threshold: 0,
            target_stock: None,
            opening_stock: 0,
            resellable: true,
            active: true,
        }
    }
}

impl ProductDraft {
    pub fn reviewed(product: &Product) -> Result<Self> {
        Ok(Self {
            name: product.name.clone(),
            sku: Some(product.sku.clone()),
            barcode: product.barcode.clone(),
            category: product.category.clone(),
            brand: product.brand.clone(),
            description: product.description.clone(),
            storage_location: product.storage_location.clone(),
            unit_label: product.unit_label.clone(),
            package_content: product.package_content.clone(),
            price_cents: u32::try_from(product.price_cents).map_err(|_| invalid())?,
            cost_cents: product
                .cost_cents
                .map(u32::try_from)
                .transpose()
                .map_err(|_| invalid())?,
            tax_basis_points: product.tax_basis_points,
            low_stock_threshold: product.low_stock_threshold,
            target_stock: product.target_stock,
            opening_stock: 0,
            resellable: product.resellable,
            active: product.active,
        })
    }

    pub fn optional(value: &str) -> Option<String> {
        let value = trim_like_javascript(value);
        (!value.is_empty()).then(|| value.to_owned())
    }

    pub fn money(value: &str) -> Option<u32> {
        parse_reviewed_amount(trim_like_javascript(value)).filter(|amount| *amount <= 999_999_999)
    }

    pub fn units(value: &str) -> Option<u32> {
        let value = trim_like_javascript(value);
        (!value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
            .then(|| {
                value
                    .parse::<u32>()
                    .ok()
                    .filter(|value| *value <= 999_999_999)
            })
            .flatten()
    }

    pub fn gross_from_net(net_cents: u32, tax_basis_points: u32) -> Option<u32> {
        (tax_basis_points <= 10_000)
            .then(|| {
                (u64::from(net_cents) * (10_000 + u64::from(tax_basis_points)) + 5_000) / 10_000
            })
            .and_then(|gross| u32::try_from(gross).ok())
            .filter(|gross| *gross <= 999_999_999)
    }

    pub(crate) fn normalized(mut self) -> Result<Self> {
        self.name = trim_like_javascript(&self.name).into();
        self.unit_label = trim_like_javascript(&self.unit_label).into();
        self.sku = self
            .sku
            .and_then(|value| Self::optional(&value))
            .map(|value| value.to_uppercase());
        let optional = |value: Option<String>| value.and_then(|value| Self::optional(&value));
        self.barcode = optional(self.barcode);
        self.category = optional(self.category);
        self.brand = optional(self.brand);
        self.description = optional(self.description);
        self.storage_location = optional(self.storage_location);
        if !(1..=160).contains(&self.name.encode_utf16().count())
            || !(1..=20).contains(&self.unit_label.encode_utf16().count())
            || self.name.contains('\0')
            || self.unit_label.contains('\0')
            || !reference_is_valid(self.sku.as_deref(), 64, true)
            || !reference_is_valid(self.barcode.as_deref(), 80, false)
            || [
                (self.category.as_deref(), 100),
                (self.brand.as_deref(), 100),
                (self.description.as_deref(), 1000),
                (self.storage_location.as_deref(), 80),
            ]
            .into_iter()
            .any(|(value, limit)| {
                value.is_some_and(|value| {
                    value.contains('\0') || value.encode_utf16().count() > limit
                })
            })
            || self.tax_basis_points > 10_000
            || [
                Some(self.price_cents),
                self.cost_cents,
                Some(self.low_stock_threshold),
                self.target_stock,
                Some(self.opening_stock),
            ]
            .into_iter()
            .flatten()
            .any(|value| value > 999_999_999)
        {
            return Err(invalid());
        }
        if let Some(pack) = &self.package_content {
            self.package_content =
                PackageContent::parse(&pack.quantity, &pack.unit).map_err(|_| invalid())?;
        }
        Ok(self)
    }

    fn fields(&self) -> Result<Map<String, Value>> {
        serde_json::to_value(self)?
            .as_object()
            .cloned()
            .ok_or_else(invalid)
    }

    pub(crate) fn changes(&self, before: &Self, version: u32) -> Result<Option<Value>> {
        let baseline = before.fields()?;
        let mut fields = self.fields()?;
        fields.remove("openingStock");
        if self.sku.is_none() {
            fields.remove("sku");
        }
        fields.retain(|name, value| baseline.get(name) != Some(value));
        if fields.is_empty() {
            return Ok(None);
        }
        fields.insert("version".into(), version.into());
        Ok(Some(Value::Object(fields)))
    }

    pub fn rebase(&self, before: &Self, current: &Self, keep_overlaps: bool) -> Result<Self> {
        let mut fields = current.fields()?;
        let baseline = before.fields()?;
        for (name, value) in self.fields()? {
            let approved = baseline.get(&name);
            if approved != Some(&value) && (keep_overlaps || fields.get(&name) == approved) {
                fields.insert(name, value);
            }
        }
        Ok(serde_json::from_value(Value::Object(fields))?)
    }

    pub(crate) fn creation(&self, id: ProductId) -> Result<Value> {
        let mut fields = self.fields()?;
        fields.remove("active");
        if self.sku.is_none() {
            fields.remove("sku");
        }
        fields.insert("id".into(), serde_json::to_value(id)?);
        Ok(Value::Object(fields))
    }
}

fn invalid() -> CoreError {
    CoreError::Invalid("Review the product details and stock limits".into())
}

fn reference_is_valid(value: Option<&str>, max: usize, first_alphanumeric: bool) -> bool {
    value.is_none_or(|value| {
        let mut bytes = value.bytes();
        (1..=max).contains(&value.len())
            && (!first_alphanumeric
                || bytes
                    .next()
                    .is_some_and(|byte| byte.is_ascii_alphanumeric()))
            && bytes.all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'/' | b'-')
            })
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProductReview {
    pub id: ProductId,
    pub version: u32,
    pub generation: String,
    pub fields: ProductDraft,
}

impl ProductReview {
    pub fn new(product: &Product) -> Result<Self> {
        let generation = product
            .inventory_generation
            .clone()
            .ok_or(CoreError::CalendarGenerationChanged)?;
        Ok(Self {
            id: product.id,
            version: product.version,
            generation,
            fields: ProductDraft::reviewed(product)?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProductProposal {
    pub id: ProductId,
    #[serde(rename = "_draft")]
    pub fields: ProductDraft,
    #[serde(rename = "_reviewed")]
    pub reviewed: Option<ProductReview>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductPhotoProposal {
    pub id: ProductId,
    pub version: Option<uuid::Uuid>,
    image_base64: Option<String>,
}

impl ProductPhotoProposal {
    fn valid_jpeg(bytes: &[u8]) -> bool {
        bytes.len() <= crate::staff_portrait_image::INPUT_LIMIT
            && crate::staff_portrait_image::is_bounded_jpeg(bytes)
    }

    pub fn new(id: ProductId, version: Option<uuid::Uuid>, jpeg: Option<&[u8]>) -> Result<Self> {
        if jpeg.is_some_and(|bytes| !Self::valid_jpeg(bytes)) {
            return Err(invalid());
        }
        Ok(Self {
            id,
            version,
            image_base64: jpeg.map(|bytes| STANDARD.encode(bytes)),
        })
    }

    pub fn image(&self) -> Result<Option<Vec<u8>>> {
        let Some(encoded) = &self.image_base64 else {
            return Ok(None);
        };
        if encoded.len() > 4 * crate::staff_portrait_image::INPUT_LIMIT.div_ceil(3) {
            return Err(invalid());
        }
        let bytes = STANDARD.decode(encoded).map_err(|_| invalid())?;
        if !Self::valid_jpeg(&bytes) {
            return Err(invalid());
        }
        Ok(Some(bytes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reviewed_product_changes_only_send_edited_fields_and_keep_exact_amounts() {
        let initial = ProductDraft {
            name: "Polish".into(),
            sku: Some("SKU-1".into()),
            price_cents: 1_151,
            ..Default::default()
        };
        let edited = ProductDraft {
            name: "Gloss".into(),
            opening_stock: 500,
            ..initial.clone()
        };
        assert_eq!(
            edited.changes(&initial, 5).unwrap().unwrap(),
            serde_json::json!({"name": "Gloss", "version": 5})
        );
        assert_eq!(ProductDraft::gross_from_net(999, 2100), Some(1209));
        assert_eq!(ProductDraft::money("12,09"), Some(1209));
        assert_eq!(ProductDraft::money("1.000,23"), None);
        let cloud = ProductDraft {
            price_cents: 1499,
            ..initial.clone()
        };
        let merged = edited.rebase(&initial, &cloud, false).unwrap();
        assert_eq!(merged.price_cents, 1499);
        assert_eq!(merged.name, "Gloss");
    }
}
