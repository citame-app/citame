use super::*;
use crate::inventory_classifications::{
    Classification, ClassificationCatalogue, ClassificationKind, ClassificationProposal, SAVE,
};

const CLASSIFICATIONS: &str = "inventory_classifications";

impl Store {
    pub fn inventory_classifications(&self) -> Result<Option<ClassificationCatalogue>> {
        if !self.can_read_cached_orders() {
            return Ok(None);
        }
        self.get_meta(CLASSIFICATIONS)?
            .map(|payload| Ok(serde_json::from_str(&payload)?))
            .transpose()
    }

    pub fn remember_inventory_classifications(
        &mut self,
        catalogue: &ClassificationCatalogue,
    ) -> Result<()> {
        self.write_transaction(|store| {
            if !store.can_read_cached_orders()
                || store.verified_reviewed_generation()? != catalogue.generation
            {
                return Err(CoreError::CalendarGenerationChanged);
            }
            Self::set_meta_at(
                &store.conn,
                CLASSIFICATIONS,
                &serde_json::to_string(catalogue)?,
            )
        })
    }

    pub fn pending_inventory_classifications(&self) -> Result<Vec<Classification>> {
        if !self.can_read_cached_orders() {
            return Ok(Vec::new());
        }
        let mut query = self
            .conn
            .prepare("SELECT payload FROM outbox WHERE kind = ?1 ORDER BY seq")?;
        let rows = query.query_map([SAVE], |row| row.get::<_, String>(0))?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }

    pub fn inventory_classification_choices(&self) -> Result<Option<ClassificationCatalogue>> {
        let Some(mut catalogue) = self.inventory_classifications()? else {
            return Ok(None);
        };
        for pending in self.pending_inventory_classifications()? {
            if pending.version == 0 && !catalogue.entries.iter().any(|row| row.id == pending.id) {
                catalogue.entries.push(pending);
            }
        }
        Ok(Some(catalogue))
    }

    pub fn queue_inventory_classification(
        &mut self,
        generation: &str,
        mut proposal: Classification,
        replaces: Option<&str>,
    ) -> Result<()> {
        if !proposal.normalize() {
            return Err(CoreError::Invalid("Review the classification".into()));
        }
        self.write_transaction(|store| {
            if !store.can_queue_product_edits()
                || store.verified_reviewed_generation()? != generation
            {
                return Err(CoreError::CalendarGenerationChanged);
            }
            let catalogue = store
                .inventory_classification_choices()?
                .filter(|list| list.generation == generation)
                .ok_or(CoreError::CalendarGenerationChanged)?;
            let current = catalogue
                .entries
                .iter()
                .find(|entry| entry.id == proposal.id);
            if current.map_or(0, |entry| entry.version) != proposal.version
                || current.is_some_and(|entry| entry.kind != proposal.kind)
            {
                return Err(CoreError::CatalogueVersionChanged);
            }
            if let Some(parent) = proposal.parent_id
                && !catalogue.entries.iter().any(|entry| {
                    entry.id == parent
                        && entry.kind == ClassificationKind::Category
                        && entry.parent_id.is_none()
                        && (entry.active || !proposal.active)
                })
            {
                return Err(CoreError::Invalid("Choose a top-level category".into()));
            }
            if catalogue.entries.iter().any(|entry| {
                entry.parent_id == Some(proposal.id)
                    && (proposal.parent_id.is_some() || (!proposal.active && entry.active))
            }) {
                return Err(CoreError::Invalid(
                    "Move or archive the subcategories first".into(),
                ));
            }
            let id = proposal.id.to_string();
            if store.conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM outbox WHERE kind = ?1 AND entity_id = ?2)",
                params![SAVE, id],
                |row| row.get::<_, bool>(0),
            )? {
                return Err(CoreError::CatalogueEditPending);
            }
            if let Some(previous) = replaces {
                let conflict = store
                    .conflict(previous)?
                    .filter(|row| row.kind == SAVE && row.entity_id == id)
                    .ok_or_else(|| CoreError::NotFound("inventory classification".into()))?;
                if conflict.reason == "conflict" {
                    let rejected: Classification = serde_json::from_value(conflict.payload)?;
                    if proposal.version <= rejected.version {
                        return Err(CoreError::CatalogueVersionChanged);
                    }
                }
                store.resolve_conflict(previous, "resubmitted")?;
            }
            let saved = ClassificationProposal {
                entry: proposal,
                reviewed: current.cloned(),
            };
            store.enqueue(SAVE, &id, serde_json::to_value(saved)?)?;
            Ok(())
        })
    }

    pub fn finish_inventory_classification_review(
        &mut self,
        generation: &str,
        conflict: &str,
        recorded: &Classification,
    ) -> Result<()> {
        self.write_transaction(|store| {
            if store.verified_reviewed_generation()? != generation
                || !store.can_read_cached_orders()
            {
                return Err(CoreError::CalendarGenerationChanged);
            }
            let row = store
                .conflict(conflict)?
                .filter(|row| row.kind == SAVE)
                .ok_or_else(|| CoreError::NotFound("inventory classification".into()))?;
            let proposal: Classification = serde_json::from_value(row.payload)?;
            if !proposal.acknowledged_by(recorded) {
                return Err(CoreError::CatalogueVersionChanged);
            }
            store.resolve_conflict(conflict, "recorded")
        })
    }
}
