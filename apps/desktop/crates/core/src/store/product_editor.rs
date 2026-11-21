use super::*;
use crate::inventory::{Product, ProductId};
use crate::product_editor::{ACCESS, CREATE, ProductDraft, ProductProposal, ProductReview, UPDATE};

impl Store {
    pub(super) fn apply_inventory_access_at(conn: &Connection, granted: bool) -> Result<()> {
        if granted {
            Self::set_meta_at(conn, ACCESS, &Self::generation_at(conn)?)?;
        } else {
            conn.execute("DELETE FROM meta WHERE key = ?1", [ACCESS])?;
            conn.execute("DELETE FROM meta WHERE key GLOB 'inventory_review:*'", [])?;
        }
        Ok(())
    }

    pub fn can_queue_product_edits(&self) -> bool {
        self.verified_reviewed_generation()
            .ok()
            .is_some_and(|generation| {
                self.get_meta(ACCESS).ok().flatten().as_ref() == Some(&generation)
            })
    }

    pub fn pending_product_edits(&self) -> Result<Vec<ProductProposal>> {
        let mut query = self
            .conn
            .prepare("SELECT payload FROM outbox WHERE kind IN (?1, ?2) ORDER BY seq")?;
        let rows = query.query_map(params![CREATE, UPDATE], |row| row.get::<_, String>(0))?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }

    pub fn remember_reviewed_product(&mut self, product: &Product) -> Result<()> {
        let reviewed = ProductReview::new(product)?;
        self.write_transaction(|store| {
            Self::ensure_generation(&store.conn, Some(&reviewed.generation))?;
            if product.can_manage && store.can_queue_product_edits() {
                let key = format!("inventory_review:{}", product.id);
                if Self::meta_at(&store.conn, &key)?
                    .and_then(|value| serde_json::from_str::<Product>(&value).ok())
                    .is_some_and(|existing| existing.version > product.version)
                {
                    return Ok(());
                }
                Self::set_meta_at(&store.conn, &key, &serde_json::to_string(product)?)?;
            }
            Ok(())
        })
    }

    pub fn reviewed_products(&self) -> Result<Vec<Product>> {
        if !self.can_queue_product_edits() {
            return Ok(Vec::new());
        }
        let mut statement = self
            .conn
            .prepare("SELECT value FROM meta WHERE key GLOB 'inventory_review:*'")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        let mut products: Vec<Product> = rows
            .map(|row| Ok(serde_json::from_str(&row?)?))
            .collect::<Result<_>>()?;
        let generation = self.verified_reviewed_generation()?;
        products.retain(|row| row.inventory_generation.as_deref() == Some(&generation));
        products.sort_by(|left, right| left.name.cmp(&right.name).then(left.id.cmp(&right.id)));
        Ok(products)
    }

    pub fn queue_product_edit(
        &mut self,
        generation: &str,
        id: ProductId,
        reviewed: Option<&ProductReview>,
        fields: ProductDraft,
        replaces: Option<&str>,
    ) -> Result<bool> {
        let fields = fields.normalized()?;
        self.write_transaction(|store| {
            Self::ensure_generation(&store.conn, Some(generation))?;
            if !store.can_queue_product_edits() {
                return Err(CoreError::Invalid(
                    "Inventory editing is unavailable".into(),
                ));
            }
            if reviewed
                .is_some_and(|row| row.id != id || row.generation != generation || row.version == 0)
            {
                return Err(CoreError::CalendarGenerationChanged);
            }
            let id_string = id.to_string();
            let existing: bool = store.conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM outbox WHERE entity_id = ?1 AND kind IN (?2, ?3))",
                params![id_string, CREATE, UPDATE],
                |row| row.get(0),
            )?;
            if existing {
                return Err(CoreError::CatalogueEditPending);
            }
            let kind = if reviewed.is_some() { UPDATE } else { CREATE };
            if let Some(previous) = replaces {
                let conflict = store
                    .conflict(previous)?
                    .filter(|row| {
                        row.entity_id == id_string
                            && matches!(row.kind.as_str(), CREATE | UPDATE)
                            && (row.kind == kind || row.requires_restored_review())
                    })
                    .ok_or_else(|| CoreError::NotFound("product draft".into()))?;
                if conflict.reason == "conflict" {
                    let proposal: ProductProposal = serde_json::from_value(conflict.payload)?;
                    if reviewed.is_none_or(|confirmed| {
                        proposal
                            .reviewed
                            .is_none_or(|old| confirmed.version <= old.version)
                    }) {
                        return Err(CoreError::CatalogueVersionChanged);
                    }
                }
            }
            let payload = match reviewed {
                Some(reviewed) => fields
                    .changes(&reviewed.fields, reviewed.version)?
                    .map(|changes| serde_json::json!({"id": id, "changes": changes})),
                None => Some(fields.creation(id)?),
            };
            let changed = payload.is_some();
            if let Some(Value::Object(mut payload)) = payload {
                payload.insert("_draft".into(), serde_json::to_value(&fields)?);
                payload.insert("_reviewed".into(), serde_json::to_value(reviewed)?);
                store.enqueue(kind, &id_string, Value::Object(payload))?;
            }
            if let Some(previous) = replaces {
                store
                    .resolve_conflict(previous, if changed { "resubmitted" } else { "reviewed" })?;
            }
            Ok(changed)
        })
    }
}
