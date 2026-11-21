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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::PortfolioEdit;
    use image::{Rgb, RgbImage, codecs::jpeg::JpegEncoder};

    fn page(service: Uuid, allowed: bool, supported: Option<bool>) -> PullResponse {
        serde_json::from_value(serde_json::json!({
            "changes": [{
                "seq": 1, "entity": "service", "id": service, "op": "upsert",
                "data": {"id": service, "name": "Treatment", "active": true, "durationMinutes": 30,
                         "bufferMinutes": 0, "priceCents": 2000, "sortOrder": 1, "currency": "EUR",
                         "onlineBooking": true, "updatedAt": "2026-03-01T10:00:00Z"}
            }],
            "nextCursor": 1,
            "headSeq": 1,
            "hasMore": false,
            "viewerEditCatalogue": allowed,
            "portfolioUploads": supported,
        }))
        .unwrap()
    }

    #[test]
    fn a_generation_change_quarantines_the_image_and_retries_the_exact_reviewed_payload() {
        let mut store = Store::open_in_memory().unwrap();
        let service = Uuid::now_v7();
        let initial = store.verified_reviewed_generation().unwrap();
        let mut jpeg = Vec::new();
        JpegEncoder::new(&mut jpeg)
            .encode_image(&RgbImage::from_pixel(24, 24, Rgb([42, 80, 78])))
            .unwrap();
        let upload = QueuedPortfolioUpload::new(
            Uuid::now_v7(),
            &PortfolioEdit {
                caption: "A treatment".into(),
                alt: "An image".into(),
                service_id: Some(service),
            },
            &jpeg,
        )
        .unwrap();
        store
            .apply_pulled_page(&page(service, true, None), false, &initial)
            .unwrap();
        assert!(
            store
                .queue_portfolio_upload(&initial, &upload, None)
                .is_err()
        );
        store
            .apply_pulled_page(&page(service, true, Some(true)), false, &initial)
            .unwrap();
        store
            .queue_portfolio_upload(&initial, &upload, None)
            .unwrap();
        let original = store.outbox(1).unwrap().pop().unwrap();

        store
            .switch_replica_generation(&initial, "restored")
            .unwrap();
        assert!(store.outbox(1).unwrap().is_empty());
        assert!(!store.can_queue_portfolio_uploads());
        store.refresh_reviewed_generation().unwrap();
        store
            .apply_pulled_page(&page(service, true, Some(true)), false, "restored")
            .unwrap();
        assert_eq!(
            store
                .conflicted_portfolio_upload(&original.mutation_id)
                .unwrap()
                .unwrap()
                .image()
                .unwrap(),
            jpeg
        );
        assert!(
            store
                .queue_portfolio_upload(&initial, &upload, Some(&original.mutation_id))
                .is_err()
        );
        let mut edited = upload.clone();
        edited.caption = "Changed caption".into();
        assert!(
            store
                .queue_portfolio_upload("restored", &edited, Some(&original.mutation_id))
                .is_err()
        );
        store
            .queue_portfolio_upload("restored", &upload, Some(&original.mutation_id))
            .unwrap();
        let replacement = store.outbox(1).unwrap().pop().unwrap();
        assert_ne!(replacement.mutation_id, original.mutation_id);
        assert_eq!(replacement.payload, original.payload);
        assert!(store.conflicts().unwrap().is_empty());
    }
}
