use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::error::{CoreError, Result};

pub const LIVE_TOPIC: &str = "resource_catalogue";
pub const MUTATION_KIND: &str = "service.resources";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SelectionMode {
    #[default]
    All,
    OneOf,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct ResourcePool {
    pub id: String,
    pub name: String,
    pub capacity: u8,
    pub active: bool,
    #[serde(default)]
    pub version: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceClaim {
    pub resource_id: String,
    pub quantity: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceResources {
    pub service_id: String,
    pub version: u64,
    #[serde(default)]
    pub selection_mode: SelectionMode,
    pub requirements: Vec<ResourceClaim>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct ReviewedServiceResources {
    pub generation: String,
    pub resources: Vec<ResourcePool>,
    pub service: ServiceResources,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct ResourceDraft {
    pub mode: SelectionMode,
    pub quantities: BTreeMap<String, u8>,
}

impl From<&ServiceResources> for ResourceDraft {
    fn from(current: &ServiceResources) -> Self {
        Self {
            mode: current.selection_mode,
            quantities: current
                .requirements
                .iter()
                .map(|row| (row.resource_id.clone(), row.quantity))
                .collect(),
        }
    }
}

impl ResourceDraft {
    pub fn change_mode(&mut self, mode: SelectionMode) {
        self.mode = mode;
        if mode == SelectionMode::OneOf {
            self.quantities.values_mut().for_each(|value| *value = 1);
        }
    }

    pub fn has_overlaps(&self, before: &Self, current: &Self) -> bool {
        self.mode_overlaps(before, current)
            || self
                .quantities
                .keys()
                .chain(before.quantities.keys())
                .any(|id| {
                    let first = before.quantities.get(id);
                    let local = self.quantities.get(id);
                    let cloud = current.quantities.get(id);
                    local != first && cloud != first && local != cloud
                })
    }

    fn added_multiple_units(&self, before: &Self) -> bool {
        self.quantities
            .iter()
            .any(|(id, count)| *count > 1 && before.quantities.get(id) != Some(count))
    }

    fn mode_overlaps(&self, before: &Self, current: &Self) -> bool {
        (self.mode == SelectionMode::OneOf
            && self.mode != before.mode
            && current.added_multiple_units(before))
            || (current.mode == SelectionMode::OneOf
                && current.mode != before.mode
                && self.added_multiple_units(before))
    }

    pub fn review(&self, before: &Self, current: &Self, keep_overlaps: bool) -> Self {
        let mut next = current.clone();
        let ids: BTreeSet<_> = self
            .quantities
            .keys()
            .chain(before.quantities.keys())
            .collect();
        for id in ids {
            let first = before.quantities.get(id);
            let local = self.quantities.get(id);
            if local != first && (keep_overlaps || current.quantities.get(id) == first) {
                if let Some(quantity) = local {
                    next.quantities.insert(id.clone(), *quantity);
                } else {
                    next.quantities.remove(id);
                }
            }
        }
        let mode = if self.mode_overlaps(before, current) {
            if keep_overlaps {
                self.mode
            } else {
                current.mode
            }
        } else if self.mode != before.mode {
            self.mode
        } else {
            current.mode
        };
        next.change_mode(mode);
        next
    }

    pub fn payload(&self, reviewed: &ReviewedServiceResources) -> Result<PendingServiceResources> {
        let current = ResourceDraft::from(&reviewed.service);
        if self.quantities.len() > 8 {
            return Err(CoreError::Invalid(
                "A service can require at most eight resources".into(),
            ));
        }
        let mut requirements = Vec::with_capacity(self.quantities.len());
        for (id, &quantity) in &self.quantities {
            let pool = reviewed.resources.iter().find(|row| &row.id == id);
            if !pool.is_some_and(|row| {
                row.active
                    && (1..=row.capacity).contains(&quantity)
                    && (self.mode == SelectionMode::All || quantity == 1)
            }) {
                return Err(CoreError::Invalid(
                    "Review the requested resource capacity".into(),
                ));
            }
            requirements.push(ResourceClaim {
                resource_id: id.clone(),
                quantity,
            });
        }
        Ok(PendingServiceResources {
            id: reviewed.service.service_id.clone(),
            version: reviewed.service.version,
            selection_mode: if requirements.is_empty() {
                SelectionMode::All
            } else {
                self.mode
            },
            requirements,
            reviewed: current,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueuedServiceResources {
    pub mutation_id: String,
    pub edit: PendingServiceResources,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingServiceResources {
    pub id: String,
    pub version: u64,
    pub selection_mode: SelectionMode,
    pub requirements: Vec<ResourceClaim>,
    #[serde(rename = "_reviewed")]
    pub reviewed: ResourceDraft,
}

impl PendingServiceResources {
    pub fn proposal(&self) -> ResourceDraft {
        ResourceDraft {
            mode: self.selection_mode,
            quantities: self
                .requirements
                .iter()
                .map(|row| (row.resource_id.clone(), row.quantity))
                .collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn review_preserves_remote_requirements_and_protects_conflicting_units() {
        let before = ResourceDraft {
            mode: SelectionMode::All,
            quantities: [("room".into(), 1)].into(),
        };
        let mut local = before.clone();
        local.quantities.insert("room".into(), 2);
        let mut cloud = before.clone();
        cloud.quantities.insert("equipment".into(), 1);
        cloud.change_mode(SelectionMode::OneOf);
        assert!(local.has_overlaps(&before, &cloud));
        assert_eq!(local.review(&before, &cloud, false), cloud);
        assert_eq!(
            local.review(&before, &cloud, true),
            ResourceDraft {
                mode: SelectionMode::All,
                quantities: [("room".into(), 2), ("equipment".into(), 1)].into(),
            }
        );
    }
}
