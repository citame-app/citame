use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const SAVE: &str = "inventory.classification_save";
pub const BRAND_LOGO: &str = "inventory.brand_logo";

pub type BrandLogoProposal = crate::product_editor::InventoryImageProposal<Uuid>;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct BrandLogo {
    pub version: Uuid,
    pub present: bool,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClassificationKind {
    Category,
    Brand,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Classification {
    pub id: Uuid,
    pub kind: ClassificationKind,
    pub parent_id: Option<Uuid>,
    pub name: String,
    pub position: u32,
    pub active: bool,
    pub version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logo: Option<BrandLogo>,
}

impl Classification {
    pub(crate) fn normalize(&mut self) -> bool {
        self.name = crate::trim_like_javascript(&self.name).to_owned();
        !self.name.is_empty()
            && !self.name.contains('\0')
            && self.name.encode_utf16().count() <= 100
            && self.position < i32::MAX as u32
            && self.version < i32::MAX as u32
            && self.parent_id != Some(self.id)
            && (self.kind == ClassificationKind::Category || self.parent_id.is_none())
    }

    pub fn acknowledged_by(&self, current: &Self) -> bool {
        self.version.checked_add(1) == Some(current.version)
            && current.id == self.id
            && current.kind == self.kind
            && current.parent_id == self.parent_id
            && current.name == self.name
            && current.position == self.position
            && current.active == self.active
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ClassificationCatalogue {
    pub entries: Vec<Classification>,
    pub generation: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ClassificationProposal {
    #[serde(flatten)]
    pub entry: Classification,
    #[serde(rename = "_reviewed", skip_serializing_if = "Option::is_none")]
    pub reviewed: Option<Classification>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassificationAssignment {
    pub category_id: Option<Uuid>,
    pub subcategory_id: Option<Uuid>,
    pub brand_id: Option<Uuid>,
}

pub const REORDER: &str = "inventory.classification_reorder";

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ClassificationRevision {
    pub id: Uuid,
    pub version: u32,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassificationOrder {
    pub kind: ClassificationKind,
    pub parent_id: Option<Uuid>,
    pub entries: Vec<ClassificationRevision>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ClassificationMove {
    pub source: Uuid,
    pub anchor: Uuid,
    pub after: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct QueuedClassificationOrder {
    #[serde(flatten)]
    pub order: ClassificationOrder,
    #[serde(rename = "move")]
    pub movement: ClassificationMove,
}

impl QueuedClassificationOrder {
    pub fn review(&self, catalogue: &ClassificationCatalogue) -> Option<ClassificationOrder> {
        let movement = self.movement;
        let current = catalogue.reviewed_order(movement.source)?;
        if (current.kind, current.parent_id) != (self.order.kind, self.order.parent_id) {
            return None;
        }
        current.move_to(movement.source, movement.anchor, movement.after)
    }
}

impl ClassificationOrder {
    pub fn matches_group(&self, entry: &Classification) -> bool {
        self.kind == entry.kind && self.parent_id == entry.parent_id
    }

    pub fn move_to(&self, source: Uuid, target: Uuid, after: bool) -> Option<Self> {
        if source == target {
            return None;
        }
        let mut proposal = self.clone();
        let source_index = proposal.entries.iter().position(|row| row.id == source)?;
        let entry = proposal.entries.remove(source_index);
        let index = proposal.entries.iter().position(|row| row.id == target)? + usize::from(after);
        proposal.entries.insert(index, entry);
        (proposal != *self).then_some(proposal)
    }
}

impl ClassificationCatalogue {
    pub fn reviewed_order(&self, source: Uuid) -> Option<ClassificationOrder> {
        let entry = self.entries.iter().find(|record| record.id == source)?;
        let entries = self
            .entries
            .iter()
            .filter(|row| row.kind == entry.kind && row.parent_id == entry.parent_id)
            .map(|row| ClassificationRevision {
                id: row.id,
                version: row.version,
            })
            .collect();
        Some(ClassificationOrder {
            kind: entry.kind,
            parent_id: entry.parent_id,
            entries,
        })
    }

    pub(crate) fn acknowledge_order(&mut self, order: &ClassificationOrder) -> bool {
        let current = self
            .entries
            .iter()
            .filter(|entry| order.matches_group(entry));
        if current
            .map(|entry| entry.id)
            .eq(order.entries.iter().map(|entry| entry.id))
            || !self.apply_reviewed_order(order)
        {
            return false;
        }
        for (position, entry) in self
            .entries
            .iter_mut()
            .filter(|entry| order.matches_group(entry))
            .enumerate()
        {
            if entry.position != position as u32 {
                entry.position = position as u32;
                entry.version += 1;
            }
        }
        true
    }

    pub(crate) fn apply_reviewed_order(&mut self, order: &ClassificationOrder) -> bool {
        let current: std::collections::HashMap<_, _> = self
            .entries
            .iter()
            .filter(|row| order.matches_group(row))
            .map(|row| (row.id, row.clone()))
            .collect();
        if current.len() != order.entries.len() {
            return false;
        }
        let mut current = current;
        let Some(rows) = order
            .entries
            .iter()
            .map(|reviewed| {
                current
                    .remove(&reviewed.id)
                    .filter(|row| row.version == reviewed.version)
            })
            .collect::<Option<Vec<_>>>()
        else {
            return false;
        };
        for (slot, row) in self
            .entries
            .iter_mut()
            .filter(|row| order.matches_group(row))
            .zip(rows)
        {
            *slot = row;
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalogue(ids: &[u128], parent_id: Option<Uuid>) -> ClassificationCatalogue {
        ClassificationCatalogue {
            generation: "initial".into(),
            entries: ids
                .iter()
                .enumerate()
                .map(|(position, &id)| Classification {
                    id: Uuid::from_u128(id),
                    kind: ClassificationKind::Category,
                    parent_id,
                    name: id.to_string(),
                    position: position as u32,
                    active: true,
                    version: 1,
                    logo: None,
                })
                .collect(),
        }
    }

    #[test]
    fn a_conflict_retains_the_original_anchor_and_group() {
        let source = Uuid::from_u128(1);
        let anchor = Uuid::from_u128(2);
        let original = catalogue(&[1, 2, 3], None);
        let movement = ClassificationMove {
            source,
            anchor,
            after: true,
        };
        let pending = QueuedClassificationOrder {
            order: original
                .reviewed_order(source)
                .unwrap()
                .move_to(source, anchor, true)
                .unwrap(),
            movement,
        };
        let expanded = catalogue(&[1, 2, 4, 3], None);
        assert_eq!(
            pending
                .review(&expanded)
                .unwrap()
                .entries
                .iter()
                .map(|entry| entry.id.as_u128())
                .collect::<Vec<_>>(),
            [2, 1, 4, 3]
        );
        assert!(
            pending
                .review(&catalogue(&[1, 2, 3], Some(Uuid::from_u128(20))))
                .is_none()
        );
        assert!(pending.review(&catalogue(&[1, 4, 3], None)).is_none());
    }
}
