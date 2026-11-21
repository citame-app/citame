use super::{HttpTransport, parse_id};
use crate::intake::{
    IntakeRequirements, RecordError, RecordResponse, RecordedResponse, RecordingCatalog,
    ResponseHistory,
};

impl HttpTransport {
    pub fn client_response_history(
        &self,
        client_id: &str,
        before: Option<&str>,
    ) -> Result<ResponseHistory, RecordError> {
        let mut path = client_path(client_id)?;
        if let Some(before) = before {
            path.push_str(&format!(
                "?before={}",
                parse_id(before).map_err(|_| RecordError::Invalid)?
            ));
        }
        self.read_private_record(&path)
    }

    pub fn client_recorded_response(
        &self,
        client_id: &str,
        response_id: &str,
    ) -> Result<RecordedResponse, RecordError> {
        let id = parse_id(response_id).map_err(|_| RecordError::Invalid)?;
        let path = format!("{}/{id}", client_path(client_id)?);
        let record: RecordedResponse = self.read_private_record(&path)?;
        if record.id != id.to_string() {
            return Err(RecordError::Retry);
        }
        Ok(record)
    }

    pub fn client_recording_catalog(
        &self,
        client_id: &str,
    ) -> Result<RecordingCatalog, RecordError> {
        self.read_private_record(&format!("{}/catalog", client_path(client_id)?))
    }

    pub fn client_recording_forms(
        &self,
        client_id: &str,
        services: &[String],
    ) -> Result<IntakeRequirements, RecordError> {
        let client = parse_id(client_id).map_err(|_| RecordError::Invalid)?;
        let services = services
            .iter()
            .map(|id| {
                parse_id(id)
                    .map(|value| value.to_string())
                    .map_err(|_| RecordError::Invalid)
            })
            .collect::<Result<Vec<_>, _>>()?;
        self.read_private_record(&format!(
            "/intake/requirements?serviceIds={}&clientId={client}",
            services.join(",")
        ))
    }

    pub fn record_client_response(&self, packet: &RecordResponse) -> Result<(), RecordError> {
        let path = format!("/admin/clients/{}/intake", packet.client_id());
        let response = self
            .send_json(&path, packet)
            .map_err(|_| RecordError::Retry)?;
        let saved: RecordedResponse = read_private_response(response)?;
        if !packet.matches(&saved) {
            return Err(RecordError::Retry);
        }
        Ok(())
    }

    fn read_private_record<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
    ) -> Result<T, RecordError> {
        let response = self
            .get(&self.agent, path, Some("application/json"))
            .map_err(|_| RecordError::Retry)?;
        read_private_response(response)
    }
}

fn client_path(id: &str) -> Result<String, RecordError> {
    let id = parse_id(id).map_err(|_| RecordError::Invalid)?;
    Ok(format!("/admin/clients/{id}/intake"))
}

fn read_private_response<T: serde::de::DeserializeOwned>(
    mut response: ureq::http::Response<ureq::Body>,
) -> Result<T, RecordError> {
    let status = response.status().as_u16();
    if status == 429 {
        let after = response
            .headers()
            .get("retry-after")
            .and_then(|value| value.to_str().ok())
            .and_then(|text| text.trim().parse::<u64>().ok())
            .map(std::time::Duration::from_secs);
        return Err(RecordError::RateLimited(after));
    }
    let body = response
        .body_mut()
        .read_to_string()
        .map_err(|_| RecordError::Retry)?;
    if matches!(status, 200 | 201) {
        return serde_json::from_str(&body).map_err(|_| RecordError::Retry);
    }
    let code = serde_json::from_str::<serde_json::Value>(&body).ok();
    match (
        status,
        code.as_ref()
            .and_then(|body| body.pointer("/error/code"))
            .and_then(serde_json::Value::as_str),
    ) {
        (401 | 403, _) => Err(RecordError::Denied),
        (404, _) => Err(RecordError::Missing),
        (409, Some("client_merged" | "version_conflict")) => Err(RecordError::Changed),
        (409, Some("storage_limit")) => Err(RecordError::Capacity),
        (400 | 409 | 422, _) => Err(RecordError::Invalid),
        _ => Err(RecordError::Retry),
    }
}
