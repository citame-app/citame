use serde::{Deserialize, Serialize};

use crate::error::{CoreError, Result};
use crate::model::{Service, ServiceOption, ServiceStaff, Staff};
use std::collections::{BTreeMap, BTreeSet};

pub const CREATE: &str = "combination.create";
pub const UPDATE: &str = "combination.update";
pub(crate) const CACHE: &str = "service_combinations";
pub const LIMIT: usize = 100;
pub const MAX_SERVICES: usize = 24;

#[derive(Debug, Default, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CombinationDraft {
    pub name: String,
    pub description: Option<String>,
    pub service_ids: Vec<String>,
    pub active: bool,
}

impl CombinationDraft {
    pub fn normalized(mut self) -> Self {
        self.name = crate::trim_like_javascript(&self.name).into();
        self.description = self
            .description
            .map(|value| crate::trim_like_javascript(&value).to_owned())
            .filter(|value| !value.is_empty());
        self
    }

    pub(crate) fn validate(&self) -> Result<()> {
        if !(1..=120).contains(&self.name.encode_utf16().count())
            || self.name.chars().any(char::is_control)
            || self.description.as_ref().is_some_and(|description| {
                description.encode_utf16().count() > 1000
                    || description
                        .chars()
                        .any(|c| matches!(c, '\x00'..='\x08' | '\x0b' | '\x0c' | '\x0e'..='\x1f' | '\x7f'))
            })
            || !(2..=MAX_SERVICES).contains(&self.service_ids.len())
            || self
                .service_ids
                .iter()
                .any(|id| uuid::Uuid::parse_str(id).is_err())
            || self
                .service_ids
                .iter()
                .collect::<BTreeSet<_>>()
                .len()
                != self.service_ids.len()
        {
            return Err(CoreError::Invalid("Review the combination name, description and services".into()));
        }
        Ok(())
    }

    pub fn rebase(&self, reviewed: &Self, current: &Self, keep_overlaps: bool) -> Self {
        fn choose<T: Eq>(proposal: T, reviewed: T, current: T, keep: bool) -> T {
            if proposal != reviewed && (keep || current == reviewed) {
                proposal
            } else {
                current
            }
        }
        Self {
            name: choose(&self.name, &reviewed.name, &current.name, keep_overlaps).clone(),
            description: choose(
                &self.description,
                &reviewed.description,
                &current.description,
                keep_overlaps,
            )
            .clone(),
            service_ids: choose(
                &self.service_ids,
                &reviewed.service_ids,
                &current.service_ids,
                keep_overlaps,
            )
            .clone(),
            active: choose(self.active, reviewed.active, current.active, keep_overlaps),
        }
    }
}

pub fn online_service(service: &Service, catalogue: &[Service]) -> bool {
    service.active
        && service.online_booking != Some(false)
        && match &service.catalog {
            Some(ServiceOption::Variant {
                parent_service_id, ..
            }) => catalogue.iter().any(|parent| {
                parent.id == *parent_service_id
                    && parent.active
                    && parent.online_booking != Some(false)
            }),
            _ => true,
        }
}

pub(crate) fn validate_online_selection(
    ids: &[String],
    catalogue: &[Service],
    staff: &[Staff],
    assignments: &[ServiceStaff],
) -> Result<()> {
    crate::ops::validate_catalogue_selection(catalogue, ids.iter().map(String::as_str))?;
    let mut parts: Vec<Vec<&str>> = Vec::new();
    for id in ids {
        let service = catalogue
            .iter()
            .find(|row| row.id == *id && online_service(row, catalogue))
            .ok_or(CoreError::IncompatibleServices)?;
        if matches!(service.catalog, Some(ServiceOption::Addon { .. })) {
            parts
                .last_mut()
                .ok_or(CoreError::IncompatibleServices)?
                .push(id);
        } else {
            parts.push(vec![id]);
        }
    }
    let active: BTreeSet<_> = staff
        .iter()
        .filter(|person| person.active)
        .map(|person| &person.id)
        .collect();
    let mut by_staff: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    for row in assignments
        .iter()
        .filter(|row| active.contains(&row.staff_id))
    {
        by_staff
            .entry(&row.staff_id)
            .or_default()
            .insert(&row.service_id);
    }
    let qualified = |ids: &[&str]| {
        by_staff
            .values()
            .any(|services| ids.iter().all(|id| services.contains(id)))
    };
    if qualified(&ids.iter().map(String::as_str).collect::<Vec<_>>())
        || (parts.len() <= 8 && parts.iter().all(|part| qualified(part)))
    {
        Ok(())
    } else {
        Err(CoreError::IncompatibleServices)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct ManagedCombination {
    pub id: String,
    pub version: u64,
    pub bookable: bool,
    #[serde(flatten)]
    pub draft: CombinationDraft,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct CombinationCatalogue {
    pub generation: String,
    pub combinations: Vec<ManagedCombination>,
}

impl CombinationCatalogue {
    pub fn at_limit(&self, pending: &[QueuedCombination]) -> bool {
        self.combinations.len()
            + pending
                .iter()
                .filter(|row| {
                    row.edit.version.is_none()
                        && self
                            .combinations
                            .iter()
                            .all(|saved| saved.id != row.edit.id)
                })
                .count()
            >= LIMIT
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct PendingCombination {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<u64>,
    #[serde(flatten)]
    pub proposed: CombinationDraft,
    #[serde(rename = "_reviewed", default, skip_serializing_if = "Option::is_none")]
    pub reviewed: Option<CombinationDraft>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueuedCombination {
    pub mutation_id: String,
    pub edit: PendingCombination,
    pub submitted: bool,
}
