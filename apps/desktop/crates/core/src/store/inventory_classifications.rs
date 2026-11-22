use super::*;
use crate::inventory_classifications::{
    Classification, ClassificationCatalogue, ClassificationKind, ClassificationMove,
    ClassificationOrder, ClassificationProposal, QueuedClassificationOrder, REORDER, SAVE,
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

    pub fn pending_inventory_orders(&self) -> Result<Vec<QueuedClassificationOrder>> {
        if !self.can_read_cached_orders() {
            return Ok(Vec::new());
        }
        let mut query = self
            .conn
            .prepare("SELECT payload FROM outbox WHERE kind = ?1 ORDER BY seq")?;
        let rows = query.query_map([REORDER], |row| row.get::<_, String>(0))?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }

    pub fn inventory_order_conflict(&self, id: &str) -> Result<Option<QueuedClassificationOrder>> {
        self.conflict(id)?
            .filter(|row| row.kind == REORDER)
            .map(|row| Ok(serde_json::from_value(row.payload)?))
            .transpose()
    }

    pub fn displayed_inventory_classifications(&self) -> Result<Option<ClassificationCatalogue>> {
        let Some(mut catalogue) = self.inventory_classifications()? else {
            return Ok(None);
        };
        for pending in self.pending_inventory_orders()? {
            catalogue.apply_reviewed_order(&pending.order);
        }
        Ok(Some(catalogue))
    }

    pub fn classification_order_pending_groups(
        &self,
    ) -> Result<std::collections::HashSet<(ClassificationKind, Option<uuid::Uuid>)>> {
        let mut groups = self
            .pending_inventory_orders()?
            .into_iter()
            .map(|pending| (pending.order.kind, pending.order.parent_id))
            .collect::<std::collections::HashSet<_>>();
        let saved = self.pending_inventory_classifications()?;
        if let Some(catalogue) = self.inventory_classifications()? {
            let saved_ids = saved
                .iter()
                .map(|entry| entry.id)
                .collect::<std::collections::HashSet<_>>();
            groups.extend(
                catalogue
                    .entries
                    .iter()
                    .filter(|entry| saved_ids.contains(&entry.id))
                    .map(|entry| (entry.kind, entry.parent_id)),
            );
        }
        groups.extend(saved.into_iter().map(|entry| (entry.kind, entry.parent_id)));
        Ok(groups)
    }

    pub(super) fn acknowledge_inventory_order_at(
        conn: &Connection,
        sent: &OutboxEntry,
    ) -> Result<()> {
        let Some(cached) = Self::meta_at(conn, CLASSIFICATIONS)? else {
            return Ok(());
        };
        let mut catalogue: ClassificationCatalogue = serde_json::from_str(&cached)?;
        let pending: QueuedClassificationOrder = serde_json::from_value(sent.payload.clone())?;
        if catalogue.generation == Self::generation_at(conn)?
            && catalogue.acknowledge_order(&pending.order)
        {
            Self::set_meta_at(conn, CLASSIFICATIONS, &serde_json::to_string(&catalogue)?)?;
        }
        Ok(())
    }

    pub fn queue_inventory_order(
        &mut self,
        generation: &str,
        movement: ClassificationMove,
        order: &ClassificationOrder,
        replaces: Option<&str>,
    ) -> Result<()> {
        self.write_transaction(|store| {
            if !store.can_queue_product_edits()
                || store.verified_reviewed_generation()? != generation
            {
                return Err(CoreError::CalendarGenerationChanged);
            }
            if store
                .classification_order_pending_groups()?
                .contains(&(order.kind, order.parent_id))
            {
                return Err(CoreError::CatalogueEditPending);
            }
            let mut catalogue = store
                .inventory_classifications()?
                .filter(|list| list.generation == generation)
                .ok_or(CoreError::CalendarGenerationChanged)?;
            if order.entries.len() < 2
                || !order.entries.iter().any(|row| row.id == movement.source)
                || !order.entries.iter().any(|row| row.id == movement.anchor)
                || !catalogue.apply_reviewed_order(order)
            {
                return Err(CoreError::CatalogueVersionChanged);
            }
            if let Some(id) = replaces {
                store
                    .conflict(id)?
                    .filter(|row| {
                        row.kind == REORDER && row.entity_id == movement.source.to_string()
                    })
                    .ok_or_else(|| CoreError::NotFound("inventory classification order".into()))?;
                store.resolve_conflict(id, "resubmitted")?;
            }
            let payload = QueuedClassificationOrder {
                order: order.clone(),
                movement,
            };
            store.enqueue(
                REORDER,
                &movement.source.to_string(),
                serde_json::to_value(payload)?,
            )?;
            Ok(())
        })
    }

    pub fn inventory_classification_choices(&self) -> Result<Option<ClassificationCatalogue>> {
        let Some(mut catalogue) = self.displayed_inventory_classifications()? else {
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
            if store.pending_inventory_orders()?.iter().any(|pending| {
                pending.order.matches_group(&proposal)
                    || current.is_some_and(|current| pending.order.matches_group(current))
            }) {
                return Err(CoreError::CatalogueEditPending);
            }
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
