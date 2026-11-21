use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const SAVE: &str = "inventory.classification_save";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
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
