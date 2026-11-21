use super::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub(super) const KIND: &str = "service.staff_replace";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceAssignment {
    pub id: String,
    pub reviewed_staff_ids: BTreeSet<String>,
    pub staff_ids: BTreeSet<String>,
}

impl ServiceAssignment {
    /// Apply just the user's additions and removals to the current team.
    pub fn proposed_on(&self, current: &BTreeSet<String>) -> BTreeSet<String> {
        current
            .iter()
            .filter(|id| !self.reviewed_staff_ids.contains(*id) || self.staff_ids.contains(*id))
            .chain(self.staff_ids.difference(&self.reviewed_staff_ids))
            .cloned()
            .collect()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AssignmentWork {
    Idle,
    Pending(ServiceAssignment),
    Conflict {
        id: String,
        change: ServiceAssignment,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssignmentSnapshot {
    pub generation: String,
    pub staff_ids: BTreeSet<String>,
    pub active_staff_ids: BTreeSet<String>,
    pub work: AssignmentWork,
}

impl AssignmentSnapshot {
    pub fn reviewed_team(&self) -> &BTreeSet<String> {
        match &self.work {
            AssignmentWork::Pending(change) => &change.staff_ids,
            _ => &self.staff_ids,
        }
    }
}

impl Store {
    pub(crate) fn pending_service_assignments(&self) -> Result<Vec<ServiceAssignment>> {
        self.rows("SELECT payload FROM outbox WHERE kind = 'service.staff_replace' ORDER BY seq")
    }

    // Keep confirmed catalogue changes visible until the authoritative pull catches up.
    // The checkpoint key keeps its original name for existing replicas.
    pub(super) fn retire_confirmed_catalogue_edits(tx: &Transaction, cursor: i64) -> Result<()> {
        tx.execute(
            "DELETE FROM outbox WHERE mutation_id IN (
               SELECT substr(key, length('assignment_ack:') + 1) FROM meta
               WHERE key GLOB 'assignment_ack:*' AND CAST(value AS INTEGER) <= ?1)",
            [cursor],
        )?;
        tx.execute(
            "DELETE FROM meta WHERE key GLOB 'assignment_ack:*' AND CAST(value AS INTEGER) <= ?1",
            [cursor],
        )?;
        Ok(())
    }

    pub fn service_assignment(&self, service_id: &str) -> Result<AssignmentSnapshot> {
        self.review_service_assignment(service_id, None)
    }

    pub fn review_service_assignment(
        &self,
        service_id: &str,
        conflict_id: Option<&str>,
    ) -> Result<AssignmentSnapshot> {
        let tx = self.conn.unchecked_transaction()?;
        let review = self.read_service_assignment(service_id, conflict_id)?;
        tx.commit()?;
        Ok(review)
    }

    fn read_service_assignment(
        &self,
        service_id: &str,
        conflict_id: Option<&str>,
    ) -> Result<AssignmentSnapshot> {
        let generation = self.verified_reviewed_generation()?;
        let found: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM service WHERE id = ?1)",
            [service_id],
            |row| row.get(0),
        )?;
        if !found {
            return Err(CoreError::NotFound("service".into()));
        }
        let staff_ids = self
            .conn
            .prepare(
                "SELECT json_extract(json, '$.staffId') FROM service_staff
                      WHERE json_extract(json, '$.serviceId') = ?1",
            )?
            .query_map([service_id], |row| row.get(0))?
            .collect::<rusqlite::Result<BTreeSet<String>>>()?;
        let pending: Option<String> = self
            .conn
            .query_row(
                "SELECT payload FROM outbox WHERE kind = ?1 AND entity_id = ?2 ORDER BY seq DESC LIMIT 1",
                params![KIND, service_id],
                |row| row.get(0),
            )
            .optional()?;
        let conflict: Option<(String, String)> = self
            .conn
            .query_row(
                "SELECT mutation_id, payload FROM conflict
                 WHERE kind = ?1 AND entity_id = ?2 AND resolved_at IS NULL
                   AND (?3 IS NULL OR mutation_id = ?3) ORDER BY seq LIMIT 1",
                params![KIND, service_id, conflict_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if conflict_id.is_some() && (conflict.is_none() || pending.is_some()) {
            return Err(CoreError::Invalid(
                "Wait for pending assignments before reviewing this conflict".into(),
            ));
        }
        let work = if let Some(payload) = pending {
            AssignmentWork::Pending(serde_json::from_str(&payload)?)
        } else if let Some((id, payload)) = conflict {
            AssignmentWork::Conflict {
                id,
                change: serde_json::from_str(&payload)?,
            }
        } else {
            AssignmentWork::Idle
        };
        Ok(AssignmentSnapshot {
            generation,
            staff_ids,
            active_staff_ids: self.staff()?.into_iter().map(|member| member.id).collect(),
            work,
        })
    }

    pub fn queue_service_assignment(
        &mut self,
        generation: &str,
        change: &ServiceAssignment,
        replaces: Option<&str>,
    ) -> Result<()> {
        self.write_transaction(|store| {
            let current = store.read_service_assignment(&change.id, replaces)?;
            if generation != current.generation {
                return Err(CoreError::CalendarGenerationChanged);
            }
            if current.reviewed_team() != &change.reviewed_staff_ids {
                return Err(CoreError::Invalid(
                    "Review the updated service assignments".into(),
                ));
            }
            let allowed = match &current.work {
                AssignmentWork::Idle => replaces.is_none(),
                AssignmentWork::Pending(_) => replaces.is_none(),
                AssignmentWork::Conflict { id, .. } => replaces == Some(id.as_str()),
            };
            if !allowed {
                return Err(CoreError::Invalid(
                    "Review the pending service assignment".into(),
                ));
            }
            let added = change.staff_ids.difference(&change.reviewed_staff_ids);
            if added
                .into_iter()
                .any(|id| !current.active_staff_ids.contains(id))
            {
                return Err(CoreError::Invalid(
                    "Only active staff can be assigned".into(),
                ));
            }
            let edited = change.staff_ids != change.reviewed_staff_ids;
            if edited {
                store.enqueue(KIND, &change.id, serde_json::to_value(change)?)?;
            }
            if let Some(id) = replaces {
                store.resolve_conflict(id, if edited { "resubmitted" } else { "reviewed" })?;
            }
            Ok(())
        })
    }
}
