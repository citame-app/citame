use super::{HttpTransport, TransportError, parse_id, read_response};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BookingAccess {
    Normal,
    Trusted,
    Blocked,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientControls {
    pub client_id: String,
    pub tags: Vec<String>,
    pub booking_access: BookingAccess,
    pub reason: Option<String>,
    pub version: u64,
    pub can_manage_booking_access: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientControlsUpdate {
    pub version: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub booking_access: Option<BookingAccess>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl HttpTransport {
    pub fn client_controls(&self, id: &str) -> Result<ClientControls, TransportError> {
        let id = parse_id(id)?;
        let path = format!("/admin/clients/{id}/controls");
        validate(
            read_response(self.get(&self.agent, &path, None)?, false)?,
            id,
        )
    }

    /// `None` means the reviewed revision is no longer current.
    pub fn save_client_controls(
        &self,
        id: &str,
        change: &ClientControlsUpdate,
    ) -> Result<Option<ClientControls>, TransportError> {
        let id = parse_id(id)?;
        let mut request = self
            .agent
            .patch(&format!("{}/admin/clients/{id}/controls", self.base_url));
        for (key, value) in self.headers()? {
            request = request.header(key, value);
        }
        let body = serde_json::to_string(change)
            .map_err(|_| TransportError::BadRequest("Invalid client controls".into()))?;
        let response = request
            .content_type("application/json")
            .send(body)
            .map_err(|error| TransportError::Offline(error.to_string()))?;
        if response.status().as_u16() == 409 {
            return Ok(None);
        }
        let saved = validate(read_response(response, false)?, id)?;
        if Some(saved.version) != change.version.checked_add(1) {
            return Err(TransportError::Server(
                "Unexpected client controls revision".into(),
            ));
        }
        Ok(Some(saved))
    }
}

fn validate(value: ClientControls, id: uuid::Uuid) -> Result<ClientControls, TransportError> {
    if value.version == 0 || parse_id(&value.client_id)? != id {
        return Err(TransportError::Server(
            "Unexpected client controls response".into(),
        ));
    }
    Ok(value)
}
