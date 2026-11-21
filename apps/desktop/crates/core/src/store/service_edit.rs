use super::*;
use crate::http::{CatalogService, ReviewedCatalog, ServiceDetails};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub const SERVICE_EDIT_KIND: &str = "service.configure";

fn valid_patch(
    current: &CatalogService,
    proposed: &ServiceDetails,
    patch: &serde_json::Map<String, Value>,
) -> bool {
    fn length(value: &str) -> usize {
        value.encode_utf16().count()
    }

    let processing_fits = proposed.processing.as_ref().is_none_or(|time| {
        time.starts_after_minutes.saturating_add(time.minutes)
            < i64::from(proposed.duration_minutes)
    });
    if (patch.contains_key("durationMinutes") || patch.contains_key("processing"))
        && !processing_fits
    {
        return false;
    }
    patch.keys().all(|field| match field.as_str() {
        "name" => (1..=200).contains(&length(proposed.name.trim())),
        "category" => proposed
            .category
            .as_deref()
            .is_none_or(|value| (1..=100).contains(&length(value.trim()))),
        "description" => proposed
            .description
            .as_deref()
            .is_none_or(|value| length(value) <= 2000),
        "clientInstructions" => proposed
            .client_instructions
            .as_deref()
            .is_none_or(|value| length(value.trim()) <= 2000),
        "color" => proposed.color.as_deref().is_none_or(|value| {
            value.strip_prefix('#').is_some_and(|hex| {
                hex.len() == 6 && hex.bytes().all(|digit| digit.is_ascii_hexdigit())
            })
        }),
        "currency" => length(&proposed.currency) == 3,
        "priceCents" => i32::try_from(proposed.price_cents).is_ok(),
        "durationMinutes" => {
            proposed.duration_minutes <= 1440
                && (proposed.duration_minutes > 0
                    || matches!(
                        current.catalog,
                        Some(crate::model::ServiceOption::Addon { .. })
                    ))
        }
        "bufferMinutes" => proposed.buffer_minutes <= 1440,
        "bookingIntervalMinutes" => proposed
            .booking_interval_minutes
            .is_none_or(|minutes| (1..=120).contains(&minutes)),
        "sortOrder" => proposed.sort_order <= 100_000,
        "processing" => proposed.processing.as_ref().is_none_or(|time| {
            (1..=1438).contains(&time.starts_after_minutes) && (1..=1438).contains(&time.minutes)
        }),
        _ => true,
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationTeam {
    pub reviewed_staff_ids: BTreeSet<String>,
    pub staff_ids: BTreeSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingServiceEdit {
    pub id: String,
    pub version: u64,
    #[serde(default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub service: serde_json::Map<String, Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assignment: Option<ConfigurationTeam>,
    #[serde(rename = "_reviewed")]
    pub reviewed: ServiceDetails,
}

impl PendingServiceEdit {
    pub fn proposal(&self) -> Result<ServiceDetails> {
        let mut proposal = serde_json::to_value(&self.reviewed)?;
        let fields = proposal
            .as_object_mut()
            .ok_or_else(|| CoreError::Invalid("Invalid reviewed service".into()))?;
        fields.extend(self.service.clone());
        Ok(serde_json::from_value(proposal)?)
    }

    pub fn affects_booking(&self) -> bool {
        self.assignment.is_some()
            || self
                .service
                .keys()
                .any(|key| !matches!(key.as_str(), "sortOrder" | "onlineBooking"))
    }
}

impl Store {
    /// Older unversioned rows stay usable for booking; they cannot authorize a catalogue write.
    pub fn reviewed_catalogue(&self) -> Result<ReviewedCatalog> {
        let tx = self.conn.unchecked_transaction()?;
        let generation = self.verified_reviewed_generation()?;
        let mut services: Vec<CatalogService> = self.rows(
            "SELECT json FROM service WHERE json_type(json, '$.version') = 'integer'
               AND json_extract(json, '$.version') > 0
               ORDER BY json_extract(json, '$.name') COLLATE NOCASE, id",
        )?;
        let mut teams = BTreeMap::<String, BTreeSet<String>>::new();
        for link in self.service_staff()? {
            teams
                .entry(link.service_id)
                .or_default()
                .insert(link.staff_id);
        }
        for row in &mut services {
            row.staff_ids = teams.remove(&row.id).unwrap_or_default();
        }
        tx.commit()?;
        Ok(ReviewedCatalog {
            generation,
            services,
        })
    }

    pub fn pending_service_edits(&self) -> Result<Vec<PendingServiceEdit>> {
        self.rows("SELECT payload FROM outbox WHERE kind = 'service.configure' ORDER BY seq")
    }

    pub(super) fn has_pending_service_configuration(&self, id: &str) -> Result<bool> {
        Ok(self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM outbox WHERE kind = ?1 AND entity_id = ?2)",
            params![SERVICE_EDIT_KIND, id],
            |row| row.get(0),
        )?)
    }

    pub fn queue_service_edit(
        &mut self,
        generation: &str,
        before: &CatalogService,
        proposed: &ServiceDetails,
        staff_ids: &BTreeSet<String>,
        replaces: Option<&str>,
    ) -> Result<bool> {
        self.write_transaction(|store| {
            if store.verified_reviewed_generation()? != generation {
                return Err(CoreError::CalendarGenerationChanged);
            }
            let id = &before.id;
            let raw: Option<String> = store
                .conn
                .query_row("SELECT json FROM service WHERE id = ?1", [id], |row| {
                    row.get(0)
                })
                .optional()?;
            let mut current = raw
                .and_then(|json| serde_json::from_str::<CatalogService>(&json).ok())
                .ok_or_else(|| CoreError::NotFound("reviewed service".into()))?;
            current.staff_ids = store.catalogue_target_staff(id)?;
            if current.version == 0
                || before.version != current.version
                || before.details != current.details
                || before.staff_ids != current.staff_ids
            {
                return Err(CoreError::CatalogueVersionChanged);
            }
            if store.has_pending_service_configuration(id)?
                || store.has_pending_service_assignment(id)?
            {
                return Err(CoreError::CatalogueEditPending);
            }
            if let Some(previous) = replaces {
                let entry = store
                    .conflict(previous)?
                    .ok_or_else(|| CoreError::NotFound("service edit".into()))?;
                if entry.kind != SERVICE_EDIT_KIND || entry.entity_id != *id {
                    return Err(CoreError::Invalid(
                        "Review the original service edit".into(),
                    ));
                }
                if entry.reason == "conflict" {
                    let rejected: PendingServiceEdit = serde_json::from_value(entry.payload)?;
                    let rejected_team = rejected
                        .assignment
                        .as_ref()
                        .map(|team| &team.reviewed_staff_ids);
                    if !current.supersedes_review(rejected.version, rejected_team) {
                        return Err(CoreError::CatalogueVersionChanged);
                    }
                }
            }
            let service = before.details.patch(proposed)?;
            if !valid_patch(&current, proposed, &service) {
                return Err(CoreError::Invalid("Invalid service details".into()));
            }
            let assignment = if &before.staff_ids == staff_ids {
                None
            } else {
                let active = store.staff()?;
                if staff_ids.len() > 200
                    || staff_ids
                        .difference(&before.staff_ids)
                        .any(|id| !active.iter().any(|row| &row.id == id))
                {
                    return Err(CoreError::Invalid(
                        "Only active staff can be assigned".into(),
                    ));
                }
                Some(ConfigurationTeam {
                    reviewed_staff_ids: before.staff_ids.clone(),
                    staff_ids: staff_ids.clone(),
                })
            };
            let queued = !service.is_empty() || assignment.is_some();
            if queued {
                let edit = PendingServiceEdit {
                    id: id.clone(),
                    version: before.version,
                    service,
                    assignment,
                    reviewed: before.details.clone(),
                };
                store.enqueue(SERVICE_EDIT_KIND, id, serde_json::to_value(edit)?)?;
            }
            if let Some(previous) = replaces {
                store
                    .resolve_conflict(previous, if queued { "resubmitted" } else { "reviewed" })?;
            }
            Ok(queued)
        })
    }
}
