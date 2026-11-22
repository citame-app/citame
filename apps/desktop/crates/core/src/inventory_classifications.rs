use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const SAVE: &str = "inventory.classification_save";

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

    pub fn reference(&self, source: Uuid) -> Option<(Uuid, bool)> {
        let index = self.entries.iter().position(|row| row.id == source)?;
        self.entries
            .get(index + 1)
            .map(|row| (row.id, false))
            .or_else(|| {
                index
                    .checked_sub(1)
                    .and_then(|index| self.entries.get(index))
                    .map(|row| (row.id, true))
            })
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

    pub fn apply_reviewed_order(&mut self, order: &ClassificationOrder) -> bool {
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
