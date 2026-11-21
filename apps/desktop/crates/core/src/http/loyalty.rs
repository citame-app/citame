use super::*;
use crate::loyalty::{
    Adjustment, AdjustmentResult, ClientChoice, Policy, ReviewedPolicy, Statement,
};
use uuid::Uuid;

const PATH: &str = "/admin/rewards/clients";
const POLICY: &str = "/admin/rewards/policy/reviewed";

impl HttpTransport {
    pub fn loyalty_policy(&self) -> Result<ReviewedPolicy, TransportError> {
        read_response(
            self.get(&self.agent, POLICY, Some("application/json"))?,
            false,
        )
    }

    pub fn save_loyalty_policy(
        &self,
        generation: &str,
        policy: &Policy,
    ) -> Result<ReviewedPolicy, TransportError> {
        let mut request = self.agent.put(&format!("{}{POLICY}", self.base_url));
        for (key, value) in self.headers()? {
            request = request.header(key, value);
        }
        let body = serde_json::to_string(policy)
            .map_err(|error| TransportError::BadRequest(error.to_string()))?;
        let response = request
            .header("x-citame-generation", generation)
            .content_type("application/json")
            .send(body)
            .map_err(|error| TransportError::Offline(error.to_string()))?;
        read_response_with(response, review_transport_error)
    }

    pub fn find_loyalty_clients(&self, search: &str) -> Result<Vec<ClientChoice>, TransportError> {
        #[derive(serde::Deserialize)]
        struct Choices {
            clients: Vec<ClientChoice>,
        }
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("search", search)
            .finish();
        let result: Choices = read_response(
            self.get(
                &self.agent,
                &format!("{PATH}?{query}"),
                Some("application/json"),
            )?,
            false,
        )?;
        Ok(result.clients)
    }

    pub fn loyalty_statement(&self, client: Uuid, page: u32) -> Result<Statement, TransportError> {
        let response = self.get(
            &self.agent,
            &format!("{PATH}/{client}?page={page}"),
            Some("application/json"),
        )?;
        read_response(response, false)
    }

    pub fn adjust_loyalty(
        &self,
        adjustment: &Adjustment,
    ) -> Result<AdjustmentResult, TransportError> {
        let mut request = self.agent.post(&format!(
            "{}{PATH}/{}/adjustments",
            self.base_url, adjustment.client_id
        ));
        for (key, value) in self.headers()? {
            request = request.header(key, value);
        }
        let body = serde_json::to_string(adjustment)
            .map_err(|error| TransportError::BadRequest(error.to_string()))?;
        let response = request
            .header("x-citame-generation", &adjustment.generation)
            .content_type("application/json")
            .send(body)
            .map_err(|error| TransportError::Offline(error.to_string()))?;
        read_response_with(response, review_transport_error)
    }
}
