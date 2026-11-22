use base64::{Engine, engine::general_purpose::STANDARD};
use rusqlite::{Connection, OpenFlags, params};
use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions, TryLockError};
use std::path::Path;
use std::time::Duration;
use uuid::Uuid;

use super::Store;
use crate::error::{CoreError, Result};
use crate::staff_portrait_image::{INPUT_LIMIT, is_bounded_jpeg};

const KEY: &str = "staff_portrait_draft";

pub struct StaffPortraitDraft {
    pub id: Uuid,
    pub staff_id: Uuid,
    pub jpeg: Vec<u8>,
    pub confirmed: bool,
}

pub struct StaffPortraitDraftClaim {
    _slot: File,
    conn: Connection,
    id: Uuid,
}

impl StaffPortraitDraftClaim {
    /// Record the successful upload before any subsequent read or UI transition.
    pub fn confirm(self) -> Result<()> {
        self.conn.execute(
            "UPDATE meta SET value = json_set(value, '$.confirmed', json('true'))
             WHERE key = ?1 AND json_extract(value, '$.id') = ?2",
            params![KEY, self.id.to_string()],
        )?;
        clear(&self.conn, self.id)?;
        Ok(())
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedDraft {
    id: Uuid,
    staff_id: Uuid,
    image_base64: String,
    #[serde(default)]
    confirmed: bool,
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

fn read(value: &str) -> Result<StaffPortraitDraft> {
    let saved: SavedDraft = serde_json::from_str(value)?;
    if saved.image_base64.len() > INPUT_LIMIT.div_ceil(3) * 4 {
        return Err(CoreError::Invalid(
            "Staff portrait draft exceeds the image limit".into(),
        ));
    }
    let jpeg = STANDARD
        .decode(&saved.image_base64)
        .map_err(|_| CoreError::Invalid("Invalid staff portrait draft encoding".into()))?;
    validate_jpeg(&jpeg)?;
    Ok(StaffPortraitDraft {
        id: saved.id,
        staff_id: saved.staff_id,
        jpeg,
        confirmed: saved.confirmed,
    })
}

fn clear(conn: &Connection, id: Uuid) -> Result<bool> {
    Ok(conn.execute(
        "DELETE FROM meta WHERE key = ?1 AND json_extract(value, '$.id') = ?2",
        params![KEY, id.to_string()],
    )? == 1)
}

fn lock_slot(path: &Path) -> Result<File> {
    let file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(path.with_extension("staff-portrait.lock"))?;
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(TryLockError::WouldBlock) => Err(CoreError::StaffPortraitDraftBusy),
        Err(TryLockError::Error(error)) => Err(error.into()),
    }
}

impl Store {
    fn staff_portrait_replica_path(&self) -> Option<&Path> {
        self.conn
            .path()
            .filter(|path| !path.is_empty())
            .map(Path::new)
    }

    /// Local selection only. The editor must fetch and review the current portrait before retrying.
    pub fn staff_portrait_draft(&self) -> Result<Option<StaffPortraitDraft>> {
        self.get_meta(KEY)?.as_deref().map(read).transpose()
    }

    pub fn reserve_staff_portrait_draft(
        &self,
        id: Uuid,
        staff_id: Uuid,
        jpeg: &[u8],
    ) -> Result<bool> {
        validate_jpeg(jpeg)?;
        let _slot = self
            .staff_portrait_replica_path()
            .map(lock_slot)
            .transpose()?;
        let value = serde_json::to_string(&SavedDraft {
            id,
            staff_id,
            image_base64: STANDARD.encode(jpeg),
            confirmed: false,
        })?;
        Ok(self.conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO NOTHING",
            params![KEY, value],
        )? == 1)
    }

    pub fn claim_staff_portrait_draft(&self, id: Uuid) -> Result<Option<StaffPortraitDraftClaim>> {
        let Some(path) = self.staff_portrait_replica_path() else {
            return Ok(None);
        };
        let slot = lock_slot(path)?;
        let matches = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM meta WHERE key = ?1 AND json_extract(value, '$.id') = ?2
              AND coalesce(json_extract(value, '$.confirmed'), 0) = 0)",
            params![KEY, id.to_string()],
            |row| row.get::<_, bool>(0),
        )?;
        if !matches {
            return Ok(None);
        }
        let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        conn.busy_timeout(Duration::from_secs(5))?;
        Ok(Some(StaffPortraitDraftClaim {
            _slot: slot,
            conn,
            id,
        }))
    }

    /// A delayed acknowledgement or discard cannot clear a different selection.
    pub fn clear_staff_portrait_draft(&self, id: Uuid) -> Result<bool> {
        let _slot = self
            .staff_portrait_replica_path()
            .map(lock_slot)
            .transpose()?;
        clear(&self.conn, id)
    }

    /// Remove a row only if it is still unreadable when the operator confirms.
    pub fn clear_unreadable_staff_portrait_draft(&self) -> Result<bool> {
        let _slot = self
            .staff_portrait_replica_path()
            .map(lock_slot)
            .transpose()?;
        let Some(value) = self.get_meta(KEY)? else {
            return Ok(false);
        };
        if read(&value).is_ok() {
            return Ok(false);
        }
        Ok(self.conn.execute(
            "DELETE FROM meta WHERE key = ?1 AND value = ?2",
            params![KEY, value],
        )? == 1)
    }
}
