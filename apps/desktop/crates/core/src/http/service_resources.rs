use super::*;
use crate::service_resources::ReviewedServiceResources;

impl HttpTransport {
    pub fn service_resources(
        &self,
        service_id: &str,
    ) -> Result<ReviewedServiceResources, TransportError> {
        let id = parse_id(service_id)?;
        let snapshot: ReviewedServiceResources = read_response(
            self.get(
                &self.agent,
                &format!("/admin/services/{id}/resources/reviewed"),
                None,
            )?,
            false,
        )?;
        if snapshot.service.service_id != id.to_string()
            || snapshot.service.version == 0
            || snapshot.generation.is_empty()
        {
            return Err(TransportError::Server(
                "Unexpected service resources response".into(),
            ));
        }
        Ok(snapshot)
    }
}
