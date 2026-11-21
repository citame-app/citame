use super::*;
use crate::booking_links::{PublicCatalog, PublicProfessional, PublicTreatment, public_origin};

#[derive(serde::Deserialize)]
struct Treatments {
    services: Vec<PublicTreatment>,
}

#[derive(serde::Deserialize)]
struct Professionals {
    staff: Vec<PublicProfessional>,
}

#[derive(serde::Deserialize)]
struct Salon {
    name: String,
}

impl HttpTransport {
    /// Use the same public gateway endpoints as the booking page, without operator credentials.
    pub fn public_booking_catalog(&self) -> Result<PublicCatalog, TransportError> {
        let origin = public_origin(&self.base_url)
            .ok_or_else(|| TransportError::BadRequest("Invalid booking origin".into()))?;
        let read = |path: &str| {
            let url = origin
                .join(path)
                .map_err(|error| TransportError::BadRequest(error.to_string()))?;
            self.agent
                .get(url.as_str())
                .header("Accept", "application/json")
                .header("Cache-Control", "no-cache")
                .call()
                .map_err(|error| TransportError::Offline(error.to_string()))
        };
        let treatments: Treatments = read_response(read("/api/services")?, false)?;
        let professionals: Professionals = read_response(read("/api/staff")?, false)?;
        let salon: Salon = read_response(read("/api/salon")?, false)?;
        Ok(PublicCatalog {
            services: treatments.services,
            staff: professionals.staff,
            salon_name: salon.name,
        })
    }
}
