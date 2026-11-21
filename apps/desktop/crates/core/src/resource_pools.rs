use serde::{Deserialize, Serialize};

use crate::error::{CoreError, Result};

pub const CREATE: &str = "resource.create";
pub const UPDATE: &str = "resource.update";
pub(crate) const CACHE: &str = "resource_pool_catalogue";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceKind {
    Room,
    Equipment,
    Station,
    Other,
}

impl ResourceKind {
    pub const ALL: [Self; 4] = [Self::Room, Self::Equipment, Self::Station, Self::Other];
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct PoolDraft {
    pub name: String,
    pub kind: ResourceKind,
    pub capacity: u8,
    pub active: bool,
}

impl Default for PoolDraft {
    fn default() -> Self {
        Self {
            name: String::new(),
            kind: ResourceKind::Room,
            capacity: 1,
            active: true,
        }
    }
}

impl PoolDraft {
    pub fn normalized_name(name: &str) -> &str {
        crate::trim_like_javascript(name)
    }

    pub fn validated(mut self) -> Result<Self> {
        self.name = Self::normalized_name(&self.name).to_owned();
        if (1..=80).contains(&self.name.encode_utf16().count()) && (1..=20).contains(&self.capacity)
        {
            Ok(self)
        } else {
            Err(CoreError::Invalid(
                "Review the resource name and capacity".into(),
            ))
        }
    }

    pub fn rebase(&self, before: &Self, current: &Self, keep_overlaps: bool) -> Self {
        fn choose<T: Copy + Eq>(local: T, before: T, current: T, keep: bool) -> T {
            if local != before && (keep || current == before) {
                local
            } else {
                current
            }
        }
        Self {
            name: choose(
                self.name.as_str(),
                before.name.as_str(),
                current.name.as_str(),
                keep_overlaps,
            )
            .into(),
            kind: choose(self.kind, before.kind, current.kind, keep_overlaps),
            capacity: choose(
                self.capacity,
                before.capacity,
                current.capacity,
                keep_overlaps,
            ),
            active: choose(self.active, before.active, current.active, keep_overlaps),
        }
    }

    pub fn overlaps(&self, before: &Self, current: &Self) -> bool {
        self.rebase(before, current, true) != self.rebase(before, current, false)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct ManagedPool {
    pub id: String,
    pub version: u64,
    #[serde(flatten)]
    pub settings: PoolDraft,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct PoolCatalogue {
    pub generation: String,
    pub pools: Vec<ManagedPool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct PendingPool {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<u64>,
    #[serde(flatten)]
    pub proposed: PoolDraft,
    #[serde(rename = "_reviewed", default, skip_serializing_if = "Option::is_none")]
    pub reviewed: Option<PoolDraft>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueuedPool {
    pub mutation_id: String,
    pub edit: PendingPool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resource_name_matches_cloud_white_space_rules() {
        assert_eq!(PoolDraft::normalized_name(" \u{0085}\u{feff}"), "\u{0085}");
        assert!(
            PoolDraft {
                name: "\u{0085}".into(),
                ..PoolDraft::default()
            }
            .validated()
            .is_ok()
        );
    }

    #[test]
    fn review_keeps_an_unrelated_cloud_capacity_and_resolves_overlapping_names() {
        let before = PoolDraft {
            name: "Original".into(),
            ..PoolDraft::default()
        };
        let local = PoolDraft {
            name: "Local".into(),
            ..before.clone()
        };
        let cloud = PoolDraft {
            name: "Cloud".into(),
            capacity: 4,
            ..before.clone()
        };
        assert!(local.overlaps(&before, &cloud));
        let review = local.rebase(&before, &cloud, true);
        assert_eq!(review.name, "Local");
        assert_eq!(review.capacity, 4);
        assert_eq!(local.rebase(&before, &cloud, false), cloud);
    }
}
