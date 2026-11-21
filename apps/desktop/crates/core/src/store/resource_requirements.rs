use super::*;
use crate::service_resources::{
    LIVE_TOPIC, MUTATION_KIND, PendingServiceResources, QueuedServiceResources, ResourceDraft,
    ReviewedServiceResources,
};

const CACHE_PREFIX: &str = "reviewed_service_resources:";

impl Store {
    pub(super) fn acknowledge_service_resources_at(
        conn: &Connection,
        entry: &OutboxEntry,
    ) -> Result<()> {
        let key = format!("{CACHE_PREFIX}{}", entry.entity_id);
        let Some(raw) = Self::meta_at(conn, &key)? else {
            return Ok(());
        };
        let mut snapshot: ReviewedServiceResources = serde_json::from_str(&raw)?;
        let edit: PendingServiceResources = serde_json::from_value(entry.payload.clone())?;
        if snapshot.service.version == edit.version
            && snapshot.generation == Self::generation_at(conn)?
        {
            // Cloud increments this revision once for the approved requirements.
            snapshot.service.version += 1;
            snapshot.service.selection_mode = edit.selection_mode;
            snapshot.service.requirements = edit.requirements;
            Self::set_meta_at(conn, &key, &serde_json::to_string(&snapshot)?)?;
        }
        Ok(())
    }

    pub fn resource_catalogue_revision(&self) -> Result<(i64, i64)> {
        Ok((
            self.live_view_revision(LIVE_TOPIC)?,
            self.catalog_revision()?,
        ))
    }

    pub fn reviewed_service_resources(&self, id: &str) -> Result<Option<ReviewedServiceResources>> {
        let generation = self.verified_reviewed_generation()?;
        let cached = self
            .get_meta(&format!("{CACHE_PREFIX}{id}"))?
            .map(|raw| serde_json::from_str::<ReviewedServiceResources>(&raw))
            .transpose()?;
        Ok(cached.filter(|snapshot| {
            snapshot.generation == generation && snapshot.service.service_id == id
        }))
    }

    pub fn remember_service_resources(
        &mut self,
        snapshot: &ReviewedServiceResources,
        observed: (i64, i64),
    ) -> Result<()> {
        self.write_transaction(|store| {
            if store.verified_reviewed_generation()? != snapshot.generation {
                return Err(CoreError::CalendarGenerationChanged);
            }
            if store.resource_catalogue_revision()? != observed {
                return Err(CoreError::CatalogueVersionChanged);
            }
            if store
                .reviewed_service_resources(&snapshot.service.service_id)?
                .is_some_and(|saved| saved.service.version > snapshot.service.version)
            {
                return Err(CoreError::CatalogueVersionChanged);
            }
            store.set_meta(
                &format!("{CACHE_PREFIX}{}", snapshot.service.service_id),
                &serde_json::to_string(snapshot)?,
            )
        })
    }

    pub fn pending_service_resources(&self, id: &str) -> Result<Option<QueuedServiceResources>> {
        let raw: Option<(String, String)> = self.conn.query_row(
            "SELECT mutation_id, payload FROM outbox WHERE kind = ?1 AND entity_id = ?2 ORDER BY seq LIMIT 1",
            params![MUTATION_KIND, id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional()?;
        raw.map(|(mutation_id, value)| {
            Ok(QueuedServiceResources {
                mutation_id,
                edit: serde_json::from_str(&value)?,
            })
        })
        .transpose()
    }

    pub fn queue_service_resources(
        &mut self,
        reviewed: &ReviewedServiceResources,
        draft: &ResourceDraft,
        replaces: Option<&str>,
    ) -> Result<bool> {
        self.write_transaction(|store| {
            if store.verified_reviewed_generation()? != reviewed.generation {
                return Err(CoreError::CalendarGenerationChanged);
            }
            let id = &reviewed.service.service_id;
            let current = store
                .reviewed_service_resources(id)?
                .ok_or(CoreError::CatalogueVersionChanged)?;
            if &current != reviewed {
                return Err(CoreError::CatalogueVersionChanged);
            }
            if store.pending_service_resources(id)?.is_some() {
                return Err(CoreError::CatalogueEditPending);
            }
            if let Some(previous) = replaces {
                let conflict = store
                    .conflict(previous)?
                    .filter(|row| row.kind == MUTATION_KIND && row.entity_id == *id)
                    .ok_or_else(|| CoreError::NotFound("resource requirement draft".into()))?;
                if conflict.reason == "conflict" {
                    let rejected: PendingServiceResources =
                        serde_json::from_value(conflict.payload)?;
                    if current.service.version <= rejected.version {
                        return Err(CoreError::CatalogueVersionChanged);
                    }
                }
            }
            let payload = draft.payload(&current)?;
            let changed = payload.proposal() != payload.reviewed;
            if changed
                && !payload.requirements.is_empty()
                && !store.services()?.iter().any(|service| {
                    &service.id == id && service.duration_minutes + service.buffer_minutes > 0
                })
            {
                return Err(CoreError::Invalid(
                    "A timed service is required to reserve a resource".into(),
                ));
            }
            if changed {
                store.enqueue(MUTATION_KIND, id, serde_json::to_value(payload)?)?;
            }
            if let Some(previous) = replaces {
                store
                    .resolve_conflict(previous, if changed { "resubmitted" } else { "reviewed" })?;
            }
            Ok(changed)
        })
    }
}
