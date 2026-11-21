use super::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CatalogPrice {
    #[default]
    Fixed,
    From,
    Variable,
    Hidden,
    Free,
}

impl CatalogPrice {
    pub const ALL: [Self; 5] = [
        Self::Fixed,
        Self::From,
        Self::Variable,
        Self::Hidden,
        Self::Free,
    ];

    pub fn requires_amount(self) -> bool {
        !matches!(self, Self::Variable | Self::Free)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceDetails {
    pub name: String,
    pub description: Option<String>,
    pub category: Option<String>,
    pub color: Option<String>,
    pub sort_order: u32,
    pub duration_minutes: u32,
    pub buffer_minutes: u32,
    pub processing: Option<crate::model::ProcessingTime>,
    pub booking_interval_minutes: Option<u32>,
    pub client_instructions: Option<String>,
    #[serde(default)]
    pub price_type: CatalogPrice,
    pub price_cents: u32,
    pub currency: String,
    pub online_booking: bool,
    pub active: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct CatalogService {
    pub id: String,
    pub version: u64,
    #[serde(flatten)]
    pub details: ServiceDetails,
}

#[derive(Debug, Deserialize)]
pub struct ReviewedCatalog {
    pub generation: String,
    pub services: Vec<CatalogService>,
}

#[derive(Debug, thiserror::Error)]
pub enum CatalogWriteError {
    #[error("The service configuration is invalid")]
    Invalid,
    #[error(transparent)]
    Transport(#[from] TransportError),
}

impl HttpTransport {
    pub fn reviewed_catalog(&self) -> Result<ReviewedCatalog, TransportError> {
        let response: ReviewedCatalog = read_response(
            self.get(&self.agent, "/admin/services/reviewed", None)?,
            false,
        )?;
        if response.generation.is_empty() || response.services.iter().any(|s| s.version == 0) {
            return Err(TransportError::Server(
                "Unexpected service catalogue response".into(),
            ));
        }
        Ok(response)
    }

    pub fn save_reviewed_service(
        &self,
        generation: &str,
        before: &CatalogService,
        proposed: &ServiceDetails,
    ) -> Result<CatalogService, CatalogWriteError> {
        let id = parse_id(&before.id)?;
        let values = serde_json::to_value(proposed)
            .map_err(|_| TransportError::BadRequest("Invalid service details".into()))?;
        let original = serde_json::to_value(&before.details)
            .map_err(|_| TransportError::BadRequest("Invalid reviewed service details".into()))?;
        let changes: serde_json::Map<String, serde_json::Value> = values
            .as_object()
            .into_iter()
            .flatten()
            .filter(|(key, value)| original.get(*key) != Some(*value))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        if changes.is_empty() {
            return Ok(before.clone());
        }
        let path = format!("/admin/services/{id}/reviewed");
        let response = self.send_put_json(
            &path,
            &serde_json::json!({ "generation": generation, "version": before.version, "service": changes }),
        )?;
        let saved: CatalogService = read_response_with(response, |status, retry_after, body| {
            if status == 400 {
                CatalogWriteError::Invalid
            } else {
                classify_status(status, retry_after, body, false).into()
            }
        })?;
        if saved.id != before.id || saved.version <= before.version {
            return Err(TransportError::Server("Unexpected service acknowledgement".into()).into());
        }
        Ok(saved)
    }
}
