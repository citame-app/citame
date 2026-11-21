use super::*;
use crate::http::{PORTFOLIO_UPLOAD, QueuedPortfolioUpload};
use uuid::Uuid;

const UPLOAD_SUPPORT: &str = "portfolio_upload_generation";

impl Store {
    pub(super) fn apply_portfolio_upload_support_at(
        conn: &Connection,
        supported: bool,
    ) -> Result<()> {
        if supported {
            let generation = Self::generation_at(conn)?;
            if Self::meta_at(conn, UPLOAD_SUPPORT)?.as_deref() != Some(&generation) {
                Self::set_meta_at(conn, UPLOAD_SUPPORT, &generation)?;
            }
        } else {
            conn.execute("DELETE FROM meta WHERE key = ?1", [UPLOAD_SUPPORT])?;
        }
        Ok(())
    }

    pub fn can_queue_portfolio_uploads(&self) -> bool {
        self.cached_catalogue_access()
            && self.verified_reviewed_generation().is_ok_and(|generation| {
                self.get_meta(UPLOAD_SUPPORT)
                    .is_ok_and(|entry| entry.as_deref() == Some(&generation))
            })
    }

    pub fn pending_portfolio_captions(&self, service_id: Uuid) -> Result<Vec<String>> {
        if !self.cached_catalogue_access() {
            return Ok(Vec::new());
        }
        Ok(self
            .conn
            .prepare(
                "SELECT json_extract(payload, '$.caption') FROM outbox WHERE kind = ?1
             AND json_extract(payload, '$.serviceId') = ?2 ORDER BY seq",
            )?
            .query_map(params![PORTFOLIO_UPLOAD, service_id.to_string()], |row| {
                row.get(0)
            })?
            .collect::<rusqlite::Result<_>>()?)
    }

    pub fn conflicted_portfolio_upload(&self, id: &str) -> Result<Option<QueuedPortfolioUpload>> {
        if !self.cached_catalogue_access() {
            return Ok(None);
        }
        self.conflict(id)?
            .filter(|row| row.kind == PORTFOLIO_UPLOAD)
            .map(|row| Ok(serde_json::from_value(row.payload)?))
            .transpose()
    }

    pub fn queue_portfolio_upload(
        &mut self,
        generation: &str,
        upload: &QueuedPortfolioUpload,
        replaces: Option<&str>,
    ) -> Result<()> {
        upload
            .image()
            .map_err(|error| CoreError::Invalid(error.to_string()))?;
        self.write_transaction(|store| {
            if store.verified_reviewed_generation()? != generation {
                return Err(CoreError::CalendarGenerationChanged);
            }
            if !store.can_queue_portfolio_uploads() {
                return Err(CoreError::Invalid(
                    "Portfolio uploads are unavailable".into(),
                ));
            }
            let service = upload.service_id.to_string();
            if !store
                .catalogue_template(&service)?
                .is_some_and(|row| row.active)
            {
                return Err(CoreError::Invalid("Choose an active service".into()));
            }
            let id = upload.idempotency_key.to_string();
            if store.conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM outbox WHERE kind = ?1 AND entity_id = ?2)",
                params![PORTFOLIO_UPLOAD, id],
                |row| row.get::<_, bool>(0),
            )? {
                return Err(CoreError::CatalogueEditPending);
            }
            let payload = serde_json::to_value(upload)?;
            if let Some(previous) = replaces {
                store
                    .conflict(previous)?
                    .filter(|row| row.kind == PORTFOLIO_UPLOAD && row.payload == payload)
                    .ok_or_else(|| CoreError::NotFound("reviewed portfolio draft".into()))?;
            }
            store.enqueue(PORTFOLIO_UPLOAD, &id, payload)?;
            if let Some(previous) = replaces {
                store.resolve_conflict(previous, "resubmitted")?;
            }
            Ok(())
        })
    }
}
