use super::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

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

impl ServiceDetails {
    pub(crate) fn patch(
        &self,
        proposed: &Self,
    ) -> serde_json::Result<serde_json::Map<String, serde_json::Value>> {
        let original = serde_json::to_value(self)?;
        let values = serde_json::to_value(proposed)?;
        Ok(values
            .as_object()
            .into_iter()
            .flatten()
            .filter(|(key, value)| original.get(*key) != Some(*value))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct CatalogService {
    pub id: String,
    pub version: u64,
    #[serde(flatten)]
    pub details: ServiceDetails,
    pub catalog: Option<ServiceOption>,
    #[serde(default, rename = "staffIds")]
    pub staff_ids: BTreeSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewCatalogService {
    #[serde(flatten)]
    pub details: ServiceDetails,
    pub staff_ids: BTreeSet<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub catalog: Option<ServiceOption>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServiceCreation {
    pub id: String,
    pub service: NewCatalogService,
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
        let changes = before
            .details
            .patch(proposed)
            .map_err(|_| TransportError::BadRequest("Invalid service details".into()))?;
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
