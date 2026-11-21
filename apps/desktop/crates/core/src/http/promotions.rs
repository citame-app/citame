use super::*;
use crate::promotions::{Promotion, PromotionWriteError, PromotionsPage, SavePromotion};

const PATH: &str = "/admin/rewards/promotions";

impl HttpTransport {
    pub fn promotions(&self, page: u32, search: &str) -> Result<PromotionsPage, TransportError> {
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("page", &page.to_string())
            .append_pair("search", search)
            .finish();
        read_response(
            self.get(
                &self.agent,
                &format!("{PATH}?{query}"),
                Some("application/json"),
            )?,
            false,
        )
    }

    pub fn save_promotion(&self, save: &SavePromotion) -> Result<Promotion, PromotionWriteError> {
        #[derive(serde::Serialize)]
        struct Payload<'a> {
            version: Option<u32>,
            #[serde(flatten)]
            terms: &'a crate::promotions::Terms,
        }
        let body = serde_json::to_string(&Payload {
            version: save.revision.map(|(_, version)| version),
            terms: &save.terms,
        })
        .map_err(|error| TransportError::BadRequest(error.to_string()))?;
        let mut request = if let Some((id, _)) = save.revision {
            self.agent.put(&format!("{}{PATH}/{id}", self.base_url))
        } else {
            self.agent.post(&format!("{}{PATH}", self.base_url))
        };
        for (key, value) in self.headers()? {
            request = request.header(key, value);
        }
        let response = request
            .header("x-citame-generation", &save.generation)
            .content_type("application/json")
            .send(body)
            .map_err(|error| TransportError::Offline(error.to_string()))?;
        read_response_with(response, |status, retry_after, body| {
            if status == 409
                && serde_json::from_str::<serde_json::Value>(body)
                    .ok()
                    .as_ref()
                    .and_then(|value| value.pointer("/error/code"))
                    .and_then(|code| code.as_str())
                    == Some("version_conflict")
            {
                PromotionWriteError::Conflict
            } else {
                review_transport_error(status, retry_after, body).into()
            }
        })
    }
}
