use rusqlite::params;

use crate::billing::visit_payment::{SavedVisitPayment, VisitPaymentGroup};
use crate::error::{CoreError, Result};

use super::Store;

fn key(group: VisitPaymentGroup, actor: &str) -> String {
    format!(
        "visit_payment_pending:{}:{}:{actor}",
        group.source.as_str(),
        group.group_id
    )
}

impl Store {
    pub fn pending_visit_payment(
        &self,
        group: VisitPaymentGroup,
        actor: &str,
    ) -> Result<Option<SavedVisitPayment>> {
        self.get_meta(&key(group, actor))?
            .map(|value| {
                let saved: SavedVisitPayment = serde_json::from_str(&value)?;
                if saved.group != group || saved.actor_user_id != actor {
                    return Err(CoreError::Protocol(
                        "Pending visit payment identity mismatch".into(),
                    ));
                }
                Ok(saved)
            })
            .transpose()
    }

    pub fn reserve_visit_payment(&self, saved: &SavedVisitPayment) -> Result<bool> {
        Ok(self.conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO NOTHING",
            params![
                key(saved.group, &saved.actor_user_id),
                serde_json::to_string(saved)?
            ],
        )? == 1)
    }

    pub fn clear_visit_payment(&self, saved: &SavedVisitPayment) -> Result<()> {
        self.conn.execute(
            "DELETE FROM meta WHERE key = ?1 AND value = ?2",
            params![
                key(saved.group, &saved.actor_user_id),
                serde_json::to_string(saved)?
            ],
        )?;
        Ok(())
    }
}
