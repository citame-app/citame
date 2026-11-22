use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

const PATH: &str = "/admin/settings/profile/images";
pub const PROFILE_GALLERY_LIMIT: usize = 12;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProfileImageKind {
    Logo,
    Cover,
    Gallery,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProfileImage {
    pub id: Uuid,
    pub version: Uuid,
    pub kind: ProfileImageKind,
    pub alt: String,
    pub published: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProfileImageSnapshot {
    pub revision: DateTime<Utc>,
    pub generation: String,
    pub images: Vec<ProfileImage>,
}

#[derive(Debug, Clone)]
pub enum ProfileImageAction {
    Upload {
        kind: ProfileImageKind,
        replace_id: Option<Uuid>,
        alt: String,
        jpeg: Vec<u8>,
    },
    Publish {
        id: Uuid,
        published: bool,
    },
    Remove {
        id: Uuid,
    },
}

impl HttpTransport {
    pub fn profile_images(&self) -> Result<ProfileImageSnapshot, TransportError> {
        read_response(self.get(&self.agent, PATH, None)?, false)
    }

    pub fn profile_image(&self, asset: &ProfileImage) -> Result<Vec<u8>, TransportError> {
        self.read_private_jpeg(&format!("{PATH}/{}/{}", asset.id, asset.version))
    }

    pub fn update_profile_image(
        &self,
        base: &ProfileImageSnapshot,
        action: ProfileImageAction,
    ) -> Result<ProfileImageSnapshot, TransportError> {
        let action = match action {
            ProfileImageAction::Upload {
                kind,
                replace_id,
                alt,
                jpeg,
            } => {
                if jpeg.len() > crate::staff_portrait_image::INPUT_LIMIT
                    || !jpeg.starts_with(&[255, 216, 255])
                {
                    return Err(TransportError::BadRequest("Invalid profile image".into()));
                }
                let mut action = serde_json::json!({
                    "mode": "upload", "kind": kind, "alt": alt, "imageBase64": STANDARD.encode(jpeg),
                });
                if let Some(id) = replace_id {
                    action["replaceId"] = serde_json::json!(id);
                }
                action
            }
            ProfileImageAction::Publish { id, published } => {
                serde_json::json!({"mode": "publication", "id": id, "published": published})
            }
            ProfileImageAction::Remove { id } => serde_json::json!({"mode": "remove", "id": id}),
        };
        self.put_json(
            PATH,
            &serde_json::json!({
                "generation": base.generation, "expectedRevision": base.revision, "action": action,
            }),
        )
    }
}
