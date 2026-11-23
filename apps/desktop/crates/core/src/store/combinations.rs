use super::*;
use crate::combinations::{
    CACHE, CREATE, CombinationCatalogue, CombinationDraft, LIMIT, ManagedCombination,
    PendingCombination, QueuedCombination, UPDATE, validate_fixed_selection,
    validate_online_selection,
};
use std::collections::BTreeSet;

const LEGACY_CACHE: &str = "service_combinations";

impl Store {
    pub(crate) fn reserve_combination_payloads(
        &mut self,
        generation: &str,
        batch: &[OutboxEntry],
    ) -> Result<bool> {
        let mut combinations = batch
            .iter()
            .filter(|row| matches!(row.kind.as_str(), CREATE | UPDATE))
            .peekable();
        if combinations.peek().is_none() {
            return Ok(true);
        }
        self.write_transaction(|store| {
            Self::ensure_generation(&store.conn, Some(generation))?;
            // Editors issue a new mutation ID for each revision. An absent ID means the batch
            // no longer represents the chosen draft. Do not reserve or send anything in it.
            let rows = combinations.collect::<Vec<_>>();
            for row in &rows {
                if !store.conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM outbox WHERE mutation_id = ?1)",
                    [&row.mutation_id],
                    |result| result.get::<_, bool>(0),
                )? {
                    return Ok(false);
                }
            }
            for row in rows {
                store.conn.execute(
                    "UPDATE outbox SET submitted = 1 WHERE mutation_id = ?1 AND submitted = 0",
                    [&row.mutation_id],
                )?;
            }
            Ok(true)
        })
    }

    pub(super) fn cache_combinations_at(
        conn: &Connection,
        combinations: &[ManagedCombination],
        generation: &str,
    ) -> Result<()> {
        let ids: BTreeSet<_> = combinations.iter().map(|row| &row.id).collect();
        if combinations.len() > LIMIT
            || ids.len() != combinations.len()
            || combinations.iter().any(|row| {
                row.version == 0
                    || uuid::Uuid::parse_str(&row.id).is_err()
                    || row.draft.validate().is_err()
            })
        {
            return Err(CoreError::Protocol("Invalid combination catalogue".into()));
        }
        let view = CombinationCatalogue {
            generation: generation.into(),
            combinations: combinations.to_vec(),
        };
        conn.execute("DELETE FROM meta WHERE key = ?1", [LEGACY_CACHE])?;
        Self::set_meta_at(conn, CACHE, &serde_json::to_string(&view)?)
    }

    pub(crate) fn needs_combination_snapshot(&self) -> Result<bool> {
        Ok(!self.validated_combination_catalogue || self.get_meta(CACHE)?.is_none())
    }

    pub(super) fn forget_combinations_at(conn: &Connection) -> Result<()> {
        conn.execute(
            "DELETE FROM meta WHERE key IN (?1, ?2)",
            [CACHE, LEGACY_CACHE],
        )?;
        Ok(())
    }

    pub fn managed_combinations(&self) -> Result<Option<CombinationCatalogue>> {
        let generation = self.verified_reviewed_generation()?;
        Ok(self
            .get_meta(CACHE)?
            .map(|raw| serde_json::from_str::<CombinationCatalogue>(&raw))
            .transpose()?
            .filter(|view| view.generation == generation))
    }

    pub fn pending_combinations(&self) -> Result<Vec<QueuedCombination>> {
        let mut query = self.conn.prepare(
            "SELECT mutation_id, payload, submitted FROM outbox WHERE kind IN (?1, ?2) ORDER BY seq",
        )?;
        let rows = query.query_map(params![CREATE, UPDATE], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, bool>(2)?,
            ))
        })?;
        rows.map(|row| {
            let (mutation_id, payload, submitted) = row?;
            Ok(QueuedCombination {
                mutation_id,
                edit: serde_json::from_str(&payload)?,
                submitted,
            })
        })
        .collect()
    }

    pub fn queue_combination(
        &mut self,
        generation: &str,
        id: &str,
        baseline_revision: Option<u64>,
        proposed: CombinationDraft,
        reviewed_pending: Option<&str>,
        replaces: Option<&str>,
    ) -> Result<bool> {
        uuid::Uuid::parse_str(id)
            .map_err(|_| CoreError::Invalid("Invalid combination ID".into()))?;
        let proposed = proposed.normalized();
        proposed.validate()?;
        self.write_transaction(|store| {
            let view = store
                .managed_combinations()?
                .ok_or(CoreError::CatalogueVersionChanged)?;
            if view.generation != generation {
                return Err(CoreError::CalendarGenerationChanged);
            }
            let current = view.combinations.iter().find(|row| row.id == id);
            if current.map(|row| row.version) != baseline_revision {
                return Err(CoreError::CatalogueVersionChanged);
            }
            let pending = store.pending_combinations()?;
            let pending_edit = pending.iter().find(|row| row.edit.id == id);
            if pending_edit.map(|row| row.mutation_id.as_str()) != reviewed_pending {
                return Err(CoreError::CatalogueEditPending);
            }
            if pending_edit
                .is_some_and(|row| row.submitted || row.edit.version != baseline_revision)
            {
                return Err(CoreError::CatalogueEditPending);
            }
            let kind = if current.is_some() { UPDATE } else { CREATE };
            if let Some(previous) = replaces {
                let conflict = store
                    .conflict(previous)?
                    .filter(|row| {
                        row.entity_id == id
                            && matches!(row.kind.as_str(), CREATE | UPDATE)
                            && (row.kind == kind || row.requires_restored_review())
                    })
                    .ok_or_else(|| CoreError::NotFound("combination draft".into()))?;
                let restored = conflict.requires_restored_review();
                if conflict.reason == "conflict" && !restored {
                    let edit = serde_json::from_value::<PendingCombination>(conflict.payload)?;
                    if !current.zip(edit.version).is_some_and(|(row, old)| {
                        row.can_review_rejected_version(old, edit.reviewed.as_ref())
                    }) {
                        return Err(CoreError::CatalogueVersionChanged);
                    }
                }
            }
            let changed = current.is_none_or(|row| row.draft != proposed);
            if changed {
                if current.is_none() && pending_edit.is_none() && view.at_limit(&pending) {
                    return Err(CoreError::Invalid(
                        "The salon combination limit has been reached".into(),
                    ));
                }
                let previous_terms = current.and_then(|row| row.draft.fixed_terms.as_ref());
                if proposed.fixed_terms.is_none()
                    && current.zip(pending_edit).is_some_and(|(row, pending)| {
                        pending
                            .edit
                            .reviewed
                            .as_ref()
                            .is_some_and(|draft| draft.lacked_fixed_terms(&row.draft))
                    })
                {
                    return Err(CoreError::Invalid(
                        "Save the reviewed pricing before removing it".into(),
                    ));
                }
                let selection_changed =
                    current.is_none_or(|row| row.draft.service_ids != proposed.service_ids);
                let terms_changed = previous_terms != proposed.fixed_terms.as_ref();
                if proposed.active
                    && proposed
                        .fixed_terms
                        .as_ref()
                        .is_some_and(|terms| terms.online_booking.is_none())
                {
                    return Err(CoreError::Invalid(
                        "Choose the visibility before publishing the combination".into(),
                    ));
                }
                if proposed.fixed_terms.is_none()
                    && previous_terms.is_some_and(|terms| !terms.can_remove(proposed.active))
                {
                    return Err(CoreError::Invalid(
                        "Archive the internal combination first".into(),
                    ));
                }
                if proposed.active
                    || selection_changed
                    || (terms_changed && proposed.fixed_terms.is_some())
                {
                    let catalogue = store.services()?;
                    let staff = store.staff()?;
                    if let Some(terms) = &proposed.fixed_terms {
                        validate_fixed_selection(&proposed, terms, &catalogue, &staff)?;
                    } else {
                        validate_online_selection(
                            &proposed.service_ids,
                            &catalogue,
                            &staff,
                            &store.service_staff()?,
                        )?;
                    }
                }
                let edit = PendingCombination {
                    id: id.into(),
                    version: baseline_revision,
                    proposed,
                    reviewed: current.map(|row| row.draft.clone()),
                };
                let payload = serde_json::to_value(edit)?;
                if let Some(row) = pending_edit {
                    store.conn.execute(
                        "UPDATE outbox SET mutation_id = ?1, payload = ?2 WHERE mutation_id = ?3
                         AND submitted = 0",
                        params![
                            uuid::Uuid::now_v7().to_string(),
                            serde_json::to_string(&payload)?,
                            row.mutation_id
                        ],
                    )?;
                } else {
                    store.enqueue(kind, id, payload)?;
                }
            } else if let Some(row) = pending_edit {
                store.conn.execute(
                    "DELETE FROM outbox WHERE mutation_id = ?1",
                    [&row.mutation_id],
                )?;
            }
            if let Some(previous) = replaces {
                let resolution = if changed { "resubmitted" } else { "reviewed" };
                store.resolve_conflict(previous, resolution)?;
            }
            Ok(changed)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_superseded_packet_cannot_be_sent_and_the_replacement_is_frozen_before_delivery() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("combinations.sqlite");
        let mut store = Store::open(&file).unwrap();
        let generation = store.verified_reviewed_generation().unwrap();
        Store::cache_combinations_at(&store.conn, &[], &generation).unwrap();
        let id = uuid::Uuid::now_v7().to_string();
        let proposed = CombinationDraft {
            name: "Rehearsal combination".into(),
            description: None,
            active: true,
            fixed_terms: None,
            service_ids: (0..2).map(|_| uuid::Uuid::now_v7().to_string()).collect(),
        };
        let entry = PendingCombination {
            id: id.clone(),
            version: None,
            proposed: proposed.clone(),
            reviewed: None,
        };
        store
            .enqueue(CREATE, &id, serde_json::to_value(entry).unwrap())
            .unwrap();
        let (_, first) = store.push_snapshot(1).unwrap();
        let replacement = uuid::Uuid::now_v7().to_string();
        store
            .conn
            .execute(
                "UPDATE outbox SET mutation_id = ?1 WHERE mutation_id = ?2",
                params![replacement, first[0].mutation_id],
            )
            .unwrap();
        assert!(
            !store
                .reserve_combination_payloads(&generation, &first)
                .unwrap()
        );
        let (_, revised) = store.push_snapshot(1).unwrap();
        assert_eq!(revised[0].mutation_id, replacement);
        assert!(
            store
                .reserve_combination_payloads(&generation, &revised)
                .unwrap()
        );
        drop(store);

        let mut reopened = Store::open(&file).unwrap();
        let pending = reopened.pending_combinations().unwrap();
        assert!(pending[0].submitted);
        assert!(matches!(
            reopened.queue_combination(&generation, &id, None, proposed, Some(&replacement), None),
            Err(CoreError::CatalogueEditPending)
        ));
    }
}
