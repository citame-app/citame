use super::*;
use crate::http::{ServiceCreation, ServiceDetails};
use std::collections::BTreeSet;

pub const SERVICE_CREATION_KIND: &str = "service.create";
const CATALOGUE_ACCESS: &str = "catalogue_access_generation";

impl Store {
    pub fn catalogue_template(&self, id: &str) -> Result<Option<ServiceDetails>> {
        let json: Option<String> = self
            .conn
            .query_row("SELECT json FROM service WHERE id = ?1", [id], |row| {
                row.get(0)
            })
            .optional()?;
        Ok(json.and_then(|raw| serde_json::from_str(&raw).ok()))
    }

    pub fn catalogue_target_staff(&self, id: &str) -> Result<BTreeSet<String>> {
        Ok(self
            .conn
            .prepare("SELECT json_extract(json, '$.staffId') FROM service_staff WHERE json_extract(json, '$.serviceId') = ?1")?
            .query_map([id], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?)
    }

    pub fn remember_catalogue_access(&mut self, generation: &str) -> Result<()> {
        self.set_meta_in(CATALOGUE_ACCESS, generation, generation)
    }

    pub fn forget_catalogue_access(&self) -> Result<()> {
        Self::forget_catalogue_access_at(&self.conn)
    }

    pub(super) fn forget_catalogue_access_at(conn: &Connection) -> Result<()> {
        Self::forget_resource_pools_at(conn)?;
        conn.execute(
            "DELETE FROM meta WHERE key LIKE 'reviewed_service_resources:%'",
            [],
        )?;
        conn.execute("DELETE FROM meta WHERE key = ?1", [CATALOGUE_ACCESS])?;
        Ok(())
    }

    pub(super) fn apply_catalogue_access_at(
        conn: &Connection,
        generation: &str,
        allowed: bool,
    ) -> Result<()> {
        if !allowed {
            return Self::forget_catalogue_access_at(conn);
        }
        if Self::meta_at(conn, CATALOGUE_ACCESS)?.as_deref() == Some(generation) {
            return Ok(());
        }
        Self::set_meta_at(conn, CATALOGUE_ACCESS, generation)
    }

    pub fn cached_catalogue_access(&self) -> bool {
        self.verified_reviewed_generation()
            .ok()
            .is_some_and(|current| {
                self.get_meta(CATALOGUE_ACCESS).ok().flatten().as_ref() == Some(&current)
            })
    }

    pub fn pending_service_creations(&self) -> Result<Vec<ServiceCreation>> {
        self.rows("SELECT payload FROM outbox WHERE kind = 'service.create' ORDER BY seq")
    }

    pub fn queue_service_creation(
        &mut self,
        generation: &str,
        creation: &ServiceCreation,
        replaces: Option<&str>,
    ) -> Result<()> {
        self.write_transaction(|store| {
            if store.verified_reviewed_generation()? != generation {
                return Err(CoreError::CalendarGenerationChanged);
            }
            let id = &creation.id;
            let exists: bool = store.conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM service WHERE id = ?1 UNION ALL
                 SELECT 1 FROM outbox WHERE entity_id = ?1 AND kind = 'service.create')",
                [id],
                |row| row.get(0),
            )?;
            if exists {
                return Err(CoreError::Invalid(
                    "This service is already pending or saved".into(),
                ));
            }
            if let Some(previous) = replaces {
                let conflict = store
                    .conflict(previous)?
                    .ok_or_else(|| CoreError::NotFound("service creation".into()))?;
                if conflict.kind != SERVICE_CREATION_KIND || conflict.entity_id != *id {
                    return Err(CoreError::Invalid(
                        "Review the original service creation".into(),
                    ));
                }
            }
            let input = &creation.service;
            let staff = store.staff()?;
            let invalid_targets = match &input.catalog {
                Some(ServiceOption::Variant {
                    parent_service_id, ..
                }) => !store
                    .services()?
                    .iter()
                    .any(|row| &row.id == parent_service_id && row.active && row.catalog.is_none()),
                Some(ServiceOption::Addon {
                    allowed_service_ids,
                }) => {
                    let catalogue = store.services()?;
                    allowed_service_ids.is_empty()
                        || allowed_service_ids.len() > 100
                        || allowed_service_ids.iter().any(|id| {
                            !catalogue.iter().any(|row| {
                                row.id == *id
                                    && row.active
                                    && !matches!(row.catalog, Some(ServiceOption::Addon { .. }))
                            })
                        })
                }
                None => false,
            };
            if input.staff_ids.len() > 200
                || input
                    .staff_ids
                    .iter()
                    .any(|id| !staff.iter().any(|member| &member.id == id))
                || invalid_targets
                || (input.details.duration_minutes == 0
                    && !matches!(input.catalog, Some(ServiceOption::Addon { .. })))
            {
                return Err(CoreError::Invalid(
                    "Review service duration and professional assignments".into(),
                ));
            }
            store.enqueue(SERVICE_CREATION_KIND, id, serde_json::to_value(creation)?)?;
            if let Some(previous) = replaces {
                store.resolve_conflict(previous, "resubmitted")?;
            }
            Ok(())
        })
    }
}
