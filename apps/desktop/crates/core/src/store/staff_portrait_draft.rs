use base64::{Engine, engine::general_purpose::STANDARD};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::Store;
use crate::error::{CoreError, Result};
use crate::staff_portrait_image::{INPUT_LIMIT, is_bounded_jpeg};

const KEY: &str = "staff_portrait_draft";

pub struct StaffPortraitDraft {
    pub id: Uuid,
    pub staff_id: Uuid,
    pub jpeg: Vec<u8>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedDraft {
    id: Uuid,
    staff_id: Uuid,
    image_base64: String,
}

fn validate_jpeg(jpeg: &[u8]) -> Result<()> {
    if jpeg.len() <= INPUT_LIMIT && is_bounded_jpeg(jpeg) {
        Ok(())
    } else {
        Err(CoreError::Invalid(
            "Invalid staff portrait draft image".into(),
        ))
    }
}

impl Store {
    /// Local selection only. The editor must fetch and review the current portrait before retrying.
    pub fn staff_portrait_draft(&self) -> Result<Option<StaffPortraitDraft>> {
        let Some(value) = self.get_meta(KEY)? else {
            return Ok(None);
        };
        let saved: SavedDraft = serde_json::from_str(&value)?;
        if saved.image_base64.len() > INPUT_LIMIT.div_ceil(3) * 4 {
            return Err(CoreError::Invalid(
                "Staff portrait draft exceeds the image limit".into(),
            ));
        }
        let jpeg = STANDARD
            .decode(&saved.image_base64)
            .map_err(|_| CoreError::Invalid("Invalid staff portrait draft encoding".into()))?;
        validate_jpeg(&jpeg)?;
        Ok(Some(StaffPortraitDraft {
            id: saved.id,
            staff_id: saved.staff_id,
            jpeg,
        }))
    }

    pub fn reserve_staff_portrait_draft(
        &self,
        id: Uuid,
        staff_id: Uuid,
        jpeg: &[u8],
    ) -> Result<bool> {
        validate_jpeg(jpeg)?;
        let value = serde_json::to_string(&SavedDraft {
            id,
            staff_id,
            image_base64: STANDARD.encode(jpeg),
        })?;
        Ok(self.conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO NOTHING",
            params![KEY, value],
        )? == 1)
    }

    pub fn has_staff_portrait_draft(&self, id: Uuid) -> Result<bool> {
        Ok(self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM meta WHERE key = ?1 AND json_extract(value, '$.id') = ?2)",
            params![KEY, id.to_string()],
            |row| row.get(0),
        )?)
    }

    /// A delayed acknowledgement or discard cannot clear a different selection.
    pub fn clear_staff_portrait_draft(&self, id: Uuid) -> Result<bool> {
        Ok(self.conn.execute(
            "DELETE FROM meta WHERE key = ?1 AND json_extract(value, '$.id') = ?2",
            params![KEY, id.to_string()],
        )? == 1)
    }
}
