use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const PORTFOLIO_LIVE_TOPIC: &str = "portfolio";

pub const PORTFOLIO_UPLOAD: &str = "portfolio.upload";

const PORTFOLIO: &str = "/admin/portfolio";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortfolioPhoto {
    pub id: Uuid,
    pub caption: String,
    pub alt: String,
    pub service_id: Option<Uuid>,
    pub service_name: Option<String>,
    pub status: PortfolioStatus,
    pub version: u32,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum PortfolioStatus {
    Draft,
    Published,
}

#[derive(Debug, Deserialize)]
pub struct PortfolioList {
    pub photos: Vec<PortfolioPhoto>,
    pub limit: usize,
    pub generation: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortfolioEdit {
    pub caption: String,
    pub alt: String,
    pub service_id: Option<Uuid>,
}

impl PortfolioEdit {
    pub fn normalized(&self) -> Result<Self, TransportError> {
        let valid = |value: &str| {
            !value.is_empty() && !value.contains('\0') && value.encode_utf16().count() <= 300
        };
        let caption = crate::trim_like_javascript(&self.caption);
        let alt = crate::trim_like_javascript(&self.alt);
        if !valid(caption) || !valid(alt) {
            return Err(TransportError::BadRequest(
                "Provide a caption and alternative text between 1 and 300 characters".into(),
            ));
        }
        Ok(Self {
            caption: caption.to_owned(),
            alt: alt.to_owned(),
            service_id: self.service_id,
        })
    }
}

#[derive(Clone, Copy)]
pub enum PortfolioPublication {
    ConfirmedPublish,
    Unpublish,
}

impl HttpTransport {
    pub fn portfolio(&self) -> Result<PortfolioList, TransportError> {
        let result: PortfolioList = read_response(self.get(&self.agent, PORTFOLIO, None)?, false)?;
        if result.limit != 200 || result.photos.len() > result.limit {
            return Err(TransportError::Server("Invalid portfolio listing".into()));
        }
        Ok(result)
    }

    pub fn portfolio_photo(&self, id: Uuid) -> Result<Vec<u8>, TransportError> {
        self.read_private_jpeg(&format!("{PORTFOLIO}/{id}/image"))
    }

    pub fn upload_portfolio_photo(
        &self,
        generation: &str,
        idempotency_key: Uuid,
        edit: &PortfolioEdit,
        jpeg: &[u8],
    ) -> Result<PortfolioPhoto, TransportError> {
        validate_jpeg(jpeg)?;
        let edit = edit.normalized()?;
        self.post_json(
            PORTFOLIO,
            &serde_json::json!({
                "idempotencyKey": idempotency_key,
                "generation": generation,
                "caption": edit.caption,
                "alt": edit.alt,
                "serviceId": edit.service_id,
                "imageBase64": STANDARD.encode(jpeg),
            }),
        )
    }

    pub fn edit_portfolio_photo(
        &self,
        generation: &str,
        photo: &PortfolioPhoto,
        edit: &PortfolioEdit,
    ) -> Result<PortfolioPhoto, TransportError> {
        let edit = edit.normalized()?;
        self.put_json(
            &format!("{PORTFOLIO}/{}", photo.id),
            &serde_json::json!({
                "version": photo.version,
                "generation": generation,
                "caption": edit.caption,
                "alt": edit.alt,
                "serviceId": edit.service_id,
            }),
        )
    }

    pub fn set_portfolio_publication(
        &self,
        generation: &str,
        photo: &PortfolioPhoto,
        action: PortfolioPublication,
    ) -> Result<PortfolioPhoto, TransportError> {
        let (path, input) = match action {
            PortfolioPublication::ConfirmedPublish => (
                "publish",
                serde_json::json!({"version": photo.version, "generation": generation, "publicationConfirmed": true}),
            ),
            PortfolioPublication::Unpublish => (
                "unpublish",
                serde_json::json!({"version": photo.version, "generation": generation}),
            ),
        };
        self.post_json(&format!("{PORTFOLIO}/{}/{path}", photo.id), &input)
    }

    pub fn remove_portfolio_photo(
        &self,
        generation: &str,
        photo: &PortfolioPhoto,
    ) -> Result<(), TransportError> {
        #[derive(Deserialize)]
        struct Removed {
            id: Uuid,
            removed: bool,
        }
        let result: Removed = self.post_json(
            &format!("{PORTFOLIO}/{}/remove", photo.id),
            &serde_json::json!({"version": photo.version, "generation": generation, "confirmation": true}),
        )?;
        if !result.removed || result.id != photo.id {
            return Err(TransportError::Server(
                "Unexpected portfolio response".into(),
            ));
        }
        Ok(())
    }
}

/// A service photo saved by the operator and waiting to be uploaded as a private draft.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedPortfolioUpload {
    pub idempotency_key: Uuid,
    pub service_id: Uuid,
    pub caption: String,
    pub alt: String,
    image_base64: String,
}

impl QueuedPortfolioUpload {
    pub fn new(
        idempotency_key: Uuid,
        edit: &PortfolioEdit,
        jpeg: &[u8],
    ) -> Result<Self, TransportError> {
        let edit = edit.normalized()?;
        let service_id = edit
            .service_id
            .ok_or_else(|| TransportError::BadRequest("Choose a service for this draft".into()))?;
        validate_jpeg(jpeg)?;
        Ok(Self {
            idempotency_key,
            service_id,
            caption: edit.caption,
            alt: edit.alt,
            image_base64: STANDARD.encode(jpeg),
        })
    }

    pub fn image(&self) -> Result<Vec<u8>, TransportError> {
        let bytes = STANDARD
            .decode(&self.image_base64)
            .map_err(|_| TransportError::BadRequest("Invalid portfolio JPEG".into()))?;
        validate_jpeg(&bytes)?;
        Ok(bytes)
    }
}

fn validate_jpeg(jpeg: &[u8]) -> Result<(), TransportError> {
    if jpeg.len() > crate::staff_portrait_image::INPUT_LIMIT
        || !crate::staff_portrait_image::is_bounded_jpeg(jpeg)
    {
        return Err(TransportError::BadRequest("Invalid portfolio JPEG".into()));
    }
    Ok(())
}
