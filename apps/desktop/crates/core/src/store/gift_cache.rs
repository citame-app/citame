use super::*;
use crate::http::gift_cards::{GiftCard, GiftCatalogue, GiftMovements};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

const SCOPE: &str = "gift_register_scope";
const EPOCH: &str = "gift_register_epoch";
const CATALOGUE: &str = "gift_register_catalogue";
const MOVEMENTS: &str = "gift_register_history";
const SAVED_HISTORY_PAGES: i64 = 64;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GiftCacheScope {
    pub scope: String,
    pub generation: String,
    epoch: String,
}

impl GiftCacheScope {
    fn read(conn: &Connection) -> Result<Option<Self>> {
        if Store::meta_at(conn, REBUILD_KEY)?.is_some() {
            return Ok(None);
        }
        let Some(scope) = Store::meta_at(conn, SCOPE)? else {
            return Ok(None);
        };
        Ok(Some(Self {
            scope,
            generation: Store::generation_at(conn)?,
            epoch: Store::meta_at(conn, EPOCH)?.unwrap_or_else(|| "0".into()),
        }))
    }
}

pub(super) fn clear_at(conn: &Connection) -> Result<()> {
    conn.execute(
        "DELETE FROM meta WHERE key IN (?1,?2) OR key GLOB 'gift_register_history:*'",
        [SCOPE, CATALOGUE],
    )?;
    conn.execute(
        "INSERT INTO meta(key,value) VALUES (?1,'1')
         ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1",
        [EPOCH],
    )?;
    Ok(())
}

pub(super) fn apply_scope_at(conn: &Connection, scope: Option<&str>) -> Result<()> {
    let scope = scope
        .filter(|scope| scope.len() == 64 && scope.bytes().all(|byte| byte.is_ascii_hexdigit()));
    if Store::meta_at(conn, SCOPE)?.as_deref() == scope {
        return Ok(());
    }
    clear_at(conn)?;
    if let Some(scope) = scope {
        conn.execute(
            "INSERT INTO meta (key,value) VALUES (?1,?2)",
            [SCOPE, scope],
        )?;
    }
    Ok(())
}

#[derive(Serialize, Deserialize)]
struct SavedRegister {
    actor: String,
    revision: i64,
    saved_at: DateTime<Utc>,
    cards: Vec<GiftCard>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct SavedGiftMovements {
    actor: String,
    pub saved_at: DateTime<Utc>,
    pub history: GiftMovements,
}

impl Store {
    pub fn gift_cache_scope(&self) -> Result<Option<GiftCacheScope>> {
        if self.verified_reviewed_generation().is_err() {
            return Ok(None);
        }
        GiftCacheScope::read(&self.conn)
    }

    pub fn clear_gift_register(&mut self) -> Result<()> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        clear_at(&tx)?;
        tx.commit()?;
        Ok(())
    }

    pub fn gift_catalogue(&self, actor: &str) -> Result<Option<GiftCatalogue>> {
        let tx = self.conn.unchecked_transaction()?;
        let Some(fence) = GiftCacheScope::read(&tx)? else {
            return Ok(None);
        };
        let Some(raw) = Self::meta_at(&tx, CATALOGUE)? else {
            return Ok(None);
        };
        let saved: SavedRegister = serde_json::from_str(&raw)?;
        tx.commit()?;
        Ok((saved.actor == actor).then_some(GiftCatalogue {
            scope: fence.scope,
            generation: fence.generation,
            revision: saved.revision,
            saved_at: saved.saved_at,
            cards: saved.cards,
        }))
    }

    pub fn save_gift_catalogue(
        &mut self,
        fence: &GiftCacheScope,
        actor: &str,
        catalogue: GiftCatalogue,
    ) -> Result<bool> {
        if fence.scope != catalogue.scope || fence.generation != catalogue.generation {
            return Ok(false);
        }
        let revision = catalogue.revision;
        let raw = serde_json::to_string(&SavedRegister {
            actor: actor.to_owned(),
            revision,
            saved_at: catalogue.saved_at,
            cards: catalogue.cards,
        })?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if GiftCacheScope::read(&tx)?.as_ref() != Some(fence) {
            return Ok(false);
        }
        let local_revision = Self::meta_at(&tx, "live_view:commerce")?
            .and_then(|value| value.parse::<i64>().ok())
            .unwrap_or_default();
        if revision < local_revision {
            return Ok(false);
        }
        Ok({
            let changed = tx.execute(
                "INSERT INTO meta(key,value) VALUES(?1,?2)
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value
                 WHERE CAST(json_extract(meta.value, '$.revision') AS INTEGER) <= ?3",
                params![CATALOGUE, raw, revision],
            )?;
            tx.commit()?;
            changed != 0
        })
    }

    pub fn gift_movement_history(
        &self,
        actor: &str,
        card_id: Uuid,
        page: u32,
    ) -> Result<Option<SavedGiftMovements>> {
        let tx = self.conn.unchecked_transaction()?;
        if GiftCacheScope::read(&tx)?.is_none() {
            return Ok(None);
        }
        let result = Self::meta_at(&tx, &format!("{MOVEMENTS}:{card_id}:{page}"))?
            .map(|raw| serde_json::from_str::<SavedGiftMovements>(&raw))
            .transpose()?
            .filter(|saved| saved.actor == actor && saved.history.pagination.page == page);
        tx.commit()?;
        Ok(result)
    }

    pub fn save_gift_movement_history(
        &mut self,
        fence: &GiftCacheScope,
        actor: &str,
        card_id: Uuid,
        history: &GiftMovements,
        saved_at: DateTime<Utc>,
    ) -> Result<()> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if GiftCacheScope::read(&tx)?.as_ref() != Some(fence) {
            return Ok(());
        }
        tx.execute(
            "INSERT OR REPLACE INTO meta(key,value) VALUES(?1,?2)",
            params![
                format!("{MOVEMENTS}:{card_id}:{}", history.pagination.page),
                serde_json::to_string(&SavedGiftMovements {
                    actor: actor.to_owned(),
                    saved_at,
                    history: history.clone(),
                })?,
            ],
        )?;
        tx.execute(
            "DELETE FROM meta WHERE key IN (
                SELECT key FROM meta WHERE key GLOB 'gift_register_history:*'
                ORDER BY rowid DESC LIMIT -1 OFFSET ?1
             )",
            [SAVED_HISTORY_PAGES],
        )?;
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::gift_cards::GiftStatus;
    use serde_json::json;

    #[test]
    fn offline_gift_register_survives_restart_but_is_fenced_by_account_and_access_changes() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("profile.db");
        let mut store = Store::open(&path).unwrap();
        let scope = "a".repeat(64);
        apply_scope_at(&store.conn, Some(&scope)).unwrap();
        let fence = store.gift_cache_scope().unwrap().unwrap();
        let saved_at: DateTime<Utc> = "2026-10-01T10:00:00Z".parse().unwrap();
        let id = Uuid::now_v7();
        let sample = || {
            serde_json::from_value::<GiftCard>(json!({
                "id": id, "label": "Bono Manicura", "checkoutId": Uuid::now_v7(),
                "amountCents":1500, "balanceCents":1000, "reservedCents":0,
                "availableCents":1000, "currency":"EUR", "status":"active",
                "codeLast4":"A4B2", "codeRevision":"rev", "version":3,
                "expiresAt":"2026-10-01T12:00:00Z",
            }))
            .unwrap()
        };
        let snapshot = || GiftCatalogue {
            scope: fence.scope.clone(),
            generation: fence.generation.clone(),
            revision: 7,
            saved_at,
            cards: vec![sample()],
        };
        store.set_meta("live_view:commerce", "8").unwrap();
        assert!(
            !store
                .save_gift_catalogue(&fence, "owner", snapshot())
                .unwrap()
        );
        store.set_meta("live_view:commerce", "7").unwrap();
        assert!(
            store
                .save_gift_catalogue(&fence, "owner", snapshot())
                .unwrap()
        );
        let history = serde_json::from_value(json!({
            "movements": [],
            "pagination": { "page": 1, "pageSize": 20, "total": 0 }
        }))
        .unwrap();
        store
            .save_gift_movement_history(&fence, "owner", id, &history, saved_at)
            .unwrap();
        drop(store);

        let mut restored = Store::open(&path).unwrap();
        assert!(restored.gift_catalogue("other-user").unwrap().is_none());
        assert!(
            restored
                .gift_movement_history("other-user", id, 1)
                .unwrap()
                .is_none()
        );
        let cached = restored.gift_catalogue("owner").unwrap().unwrap();
        let later = saved_at + chrono::Duration::hours(3);
        assert_eq!(cached.saved_at, saved_at);
        assert_eq!(cached.search(1, "a4b2", None, later).pagination.total, 1);
        assert_eq!(
            cached
                .search(1, "manicura", Some(GiftStatus::Expired), later)
                .pagination
                .total,
            1
        );
        assert!(
            cached
                .search(1, "", Some(GiftStatus::Active), later)
                .cards
                .is_empty()
        );
        assert!(
            restored
                .gift_movement_history("owner", id, 1)
                .unwrap()
                .is_some()
        );

        apply_scope_at(&restored.conn, None).unwrap();
        apply_scope_at(&restored.conn, Some(&scope)).unwrap();
        assert!(restored.gift_catalogue("owner").unwrap().is_none());
        assert!(
            restored
                .gift_movement_history("owner", id, 1)
                .unwrap()
                .is_none()
        );
        assert!(
            !restored
                .save_gift_catalogue(&fence, "owner", snapshot())
                .unwrap()
        );
    }
}
