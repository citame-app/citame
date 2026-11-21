use super::*;
use crate::resource_pools::{
    CACHE, CREATE, ManagedPool, PendingPool, PoolCatalogue, PoolDraft, QueuedPool, UPDATE,
};
use std::collections::BTreeSet;

impl Store {
    pub(super) fn cache_resource_pools_at(
        conn: &Connection,
        pools: &[ManagedPool],
        generation: &str,
    ) -> Result<()> {
        let ids: BTreeSet<&str> = pools.iter().map(|pool| pool.id.as_str()).collect();
        if pools.len() > 50
            || ids.len() != pools.len()
            || pools.iter().any(|pool| {
                pool.version == 0
                    || uuid::Uuid::parse_str(&pool.id).is_err()
                    || pool.settings.clone().validated().is_err()
            })
        {
            return Err(CoreError::Protocol(
                "Invalid resource pool catalogue".into(),
            ));
        }
        let view = PoolCatalogue {
            generation: generation.into(),
            pools: pools.to_vec(),
        };
        Self::set_meta_at(conn, CACHE, &serde_json::to_string(&view)?)
    }

    pub(crate) fn needs_resource_pool_snapshot(&self) -> Result<bool> {
        Ok(!self.validated_pool_catalogue || self.get_meta(CACHE)?.is_none())
    }

    pub(super) fn forget_resource_pools_at(conn: &Connection) -> Result<()> {
        conn.execute("DELETE FROM meta WHERE key = ?1", [CACHE])?;
        Ok(())
    }

    pub fn managed_resource_pools(&self) -> Result<Option<PoolCatalogue>> {
        let generation = self.verified_reviewed_generation()?;
        Ok(self
            .get_meta(CACHE)?
            .map(|raw| serde_json::from_str::<PoolCatalogue>(&raw))
            .transpose()?
            .filter(|view| view.generation == generation))
    }

    pub fn pending_resource_pools(&self) -> Result<Vec<QueuedPool>> {
        let mut query = self.conn.prepare(
            "SELECT mutation_id, payload FROM outbox WHERE kind IN (?1, ?2) ORDER BY seq",
        )?;
        let rows = query.query_map(params![CREATE, UPDATE], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.map(|row| {
            let (mutation_id, payload) = row?;
            Ok(QueuedPool {
                mutation_id,
                edit: serde_json::from_str(&payload)?,
            })
        })
        .collect()
    }

    pub fn queue_resource_pool(
        &mut self,
        generation: &str,
        id: &str,
        baseline: Option<&ManagedPool>,
        proposed: PoolDraft,
        replaces: Option<&str>,
    ) -> Result<bool> {
        uuid::Uuid::parse_str(id).map_err(|_| CoreError::Invalid("Invalid resource ID".into()))?;
        let proposed = proposed.validated()?;
        self.write_transaction(|store| {
            let view = store
                .managed_resource_pools()?
                .ok_or(CoreError::CatalogueVersionChanged)?;
            if view.generation != generation {
                return Err(CoreError::CalendarGenerationChanged);
            }
            let current = view.pools.iter().find(|pool| pool.id == id);
            if current != baseline {
                return Err(CoreError::CatalogueVersionChanged);
            }
            if store
                .pending_resource_pools()?
                .iter()
                .any(|row| row.edit.id == id)
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
                    .ok_or_else(|| CoreError::NotFound("resource draft".into()))?;
                if conflict.reason == "conflict" {
                    let edit = serde_json::from_value::<PendingPool>(conflict.payload)?;
                    if current.is_none_or(|pool| {
                        edit.version.is_none_or(|version| pool.version <= version)
                    }) {
                        return Err(CoreError::CatalogueVersionChanged);
                    }
                }
            }
            let changed = current.is_none_or(|pool| pool.settings != proposed);
            if changed {
                if current.is_none() && !proposed.active {
                    return Err(CoreError::Invalid("A new resource starts active".into()));
                }
                let pending = PendingPool {
                    id: id.into(),
                    version: current.map(|pool| pool.version),
                    proposed,
                    reviewed: current.map(|pool| pool.settings.clone()),
                };
                store.enqueue(kind, id, serde_json::to_value(pending)?)?;
            }
            if let Some(previous) = replaces {
                store
                    .resolve_conflict(previous, if changed { "resubmitted" } else { "reviewed" })?;
            }
            Ok(changed)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pool(id: &str) -> ManagedPool {
        ManagedPool {
            id: id.into(),
            version: 1,
            settings: PoolDraft {
                name: "Room".into(),
                ..PoolDraft::default()
            },
        }
    }

    fn page(cursor: i64, allowed: bool, pools: Vec<ManagedPool>) -> PullResponse {
        serde_json::from_value(serde_json::json!({
            "changes": [], "nextCursor": cursor, "headSeq": cursor, "hasMore": false,
            "viewerEditCatalogue": allowed, "resourcePools": pools,
        }))
        .unwrap()
    }

    #[test]
    fn a_denial_page_revokes_the_catalogue_without_removing_the_draft() {
        let mut store = Store::open_in_memory().unwrap();
        let id = uuid::Uuid::now_v7().to_string();
        let initial = store.verified_reviewed_generation().unwrap();
        let room = pool(&id);
        store
            .apply_pulled_page(&page(1, true, vec![room.clone()]), false, &initial)
            .unwrap();
        let proposed = PoolDraft {
            capacity: 2,
            ..room.settings.clone()
        };
        store
            .queue_resource_pool(&initial, &id, Some(&room), proposed, None)
            .unwrap();
        assert!(store.cached_catalogue_access());
        store
            .apply_pulled_page(&page(2, false, vec![room]), false, &initial)
            .unwrap();
        assert_eq!(store.cursor().unwrap(), 2);
        assert!(store.managed_resource_pools().unwrap().is_none());
        assert!(!store.cached_catalogue_access());
        assert_eq!(store.pending_resource_pools().unwrap().len(), 1);
    }

    #[test]
    fn a_restored_history_can_review_a_missing_update_or_an_already_applied_create() {
        for existed_before in [false, true] {
            let mut store = Store::open_in_memory().unwrap();
            let id = uuid::Uuid::now_v7().to_string();
            let initial = store.verified_reviewed_generation().unwrap();
            let mut room = pool(&id);
            let before = existed_before.then_some(room.clone());
            store
                .apply_pulled_page(
                    &page(1, true, before.clone().into_iter().collect()),
                    false,
                    &initial,
                )
                .unwrap();
            let proposed = PoolDraft {
                capacity: 2,
                ..room.settings.clone()
            };
            store
                .queue_resource_pool(&initial, &id, before.as_ref(), proposed.clone(), None)
                .unwrap();
            store
                .switch_replica_generation(&initial, "restored")
                .unwrap();
            store.refresh_reviewed_generation().unwrap();
            room.settings = proposed.clone();
            let restored = (!existed_before).then_some(room);
            store
                .apply_pulled_page(
                    &page(1, true, restored.clone().into_iter().collect()),
                    false,
                    "restored",
                )
                .unwrap();
            let conflict = store.conflicts().unwrap().pop().unwrap();
            assert!(conflict.requires_restored_review());
            let queued = store
                .queue_resource_pool(
                    "restored",
                    &id,
                    restored.as_ref(),
                    proposed,
                    Some(&conflict.mutation_id),
                )
                .unwrap();
            assert_eq!(queued, existed_before);
            assert!(store.conflicts().unwrap().is_empty());
            if queued {
                assert_eq!(store.outbox(1).unwrap()[0].kind, CREATE);
            }
        }
    }
}
