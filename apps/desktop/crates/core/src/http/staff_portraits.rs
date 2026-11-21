use super::*;
use crate::staff_portrait_image::INPUT_LIMIT;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Deserialize;

const STAFF: &str = "/admin/staff";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortraitStaff {
    pub id: String,
    pub display_name: String,
    pub active: bool,
    pub portrait_version: Option<String>,
    pub portrait_absence_version: Option<String>,
    #[serde(default)]
    pub portrait_published: bool,
}

impl PortraitStaff {
    pub fn upload_version(&self) -> Option<&str> {
        self.portrait_version
            .as_deref()
            .or(self.portrait_absence_version.as_deref())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortraitDirectory {
    #[serde(default, rename = "canEditPortraits")]
    pub can_edit: bool,
    pub staff: Vec<PortraitStaff>,
}

pub enum PortraitUpdate {
    Upload {
        version: Option<String>,
        jpeg: Vec<u8>,
    },
    Remove {
        version: String,
    },
    Publish {
        version: String,
        published: bool,
    },
}

impl HttpTransport {
    pub fn portrait_directory(&self) -> Result<PortraitDirectory, TransportError> {
        read_response(self.get(&self.agent, STAFF, None)?, false)
    }

    pub fn staff_portrait(&self, id: &str, version: &str) -> Result<Vec<u8>, TransportError> {
        let path = format!(
            "{STAFF}/{}/portrait?v={}",
            parse_id(id)?,
            parse_id(version)?
        );
        self.read_private_jpeg(&path)
    }

    pub fn set_staff_portrait(
        &self,
        id: &str,
        update: PortraitUpdate,
    ) -> Result<(), TransportError> {
        let path = format!("{STAFF}/{}/portrait", parse_id(id)?);
        let (path, input) = match update {
            PortraitUpdate::Upload { version, jpeg } => {
                let version = version.as_deref().map(parse_id).transpose()?;
                if jpeg.len() > INPUT_LIMIT || !jpeg.starts_with(&[255, 216, 255]) {
                    return Err(TransportError::BadRequest("Invalid portrait upload".into()));
                }
                (
                    path,
                    serde_json::json!({"version": version.map(|id| id.to_string()), "imageBase64": STANDARD.encode(jpeg)}),
                )
            }
            PortraitUpdate::Remove { version } => (
                path,
                serde_json::json!({"version": parse_id(&version)?.to_string(), "imageBase64": null}),
            ),
            PortraitUpdate::Publish { version, published } => (
                format!("{path}/publication"),
                serde_json::json!({"version": parse_id(&version)?.to_string(), "published": published}),
            ),
        };
        let _: serde_json::Value = self.put_json(&path, &input)?;
        Ok(())
    }
}
