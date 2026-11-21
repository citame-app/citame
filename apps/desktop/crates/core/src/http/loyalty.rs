use super::*;
use crate::loyalty::stamps::{
    Card, Cards, Command, RewardNoticeRead, RewardNotices,
    programme::{Programme, Review},
};
use crate::loyalty::{
    Adjustment, AdjustmentResult, ClientChoice, Policy, ReviewedPolicy, Statement,
};
use uuid::Uuid;

const PATH: &str = "/admin/rewards/clients";
const STAMPS: &str = "/admin/rewards/stamps";
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
        let response = self.send_put_json_with_headers(
            POLICY,
            policy,
            &[("x-citame-generation", generation)],
        )?;
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

    pub fn stamp_notices(
        &self,
        page: u32,
        unread: bool,
        summary: bool,
    ) -> Result<RewardNotices, TransportError> {
        let summary = if summary { "&summary=true" } else { "" };
        read_response(
            self.get(
                &self.agent,
                &format!("{STAMPS}/notices?page={page}&unread={unread}{summary}"),
                Some("application/json"),
            )?,
            false,
        )
    }

    pub fn read_stamp_notice(&self, input: &RewardNoticeRead) -> Result<(), TransportError> {
        #[derive(serde::Deserialize)]
        struct Receipt {
            ok: bool,
        }
        let result: Receipt = read_response_with(
            self.send_json(&format!("{STAMPS}/notices/read"), input)?,
            review_transport_error,
        )?;
        if !result.ok {
            return Err(TransportError::Server(
                "Unexpected reward notice acknowledgement".into(),
            ));
        }
        Ok(())
    }

    pub fn stamp_programme(&self) -> Result<Programme, TransportError> {
        read_response(
            self.get(
                &self.agent,
                &format!("{STAMPS}/program"),
                Some("application/json"),
            )?,
            false,
        )
    }

    pub fn save_stamp_programme(&self, review: &Review) -> Result<Programme, TransportError> {
        let response = self.send_put_json(&format!("{STAMPS}/program"), review)?;
        let saved: Programme = read_response_with(response, review_transport_error)?;
        if !review.matches_successor(&saved) {
            return Err(TransportError::Server(
                "Unexpected stamp programme acknowledgement".into(),
            ));
        }
        Ok(saved)
    }

    pub fn stamp_cards(&self, client: Uuid) -> Result<Cards, TransportError> {
        read_response(
            self.get(
                &self.agent,
                &format!("{STAMPS}/clients/{client}"),
                Some("application/json"),
            )?,
            false,
        )
    }

    pub fn change_stamp_card(&self, command: &Command) -> Result<Card, TransportError> {
        let response = match command {
            Command::Issue(issue) => self.send_json(&format!("{STAMPS}/cards"), issue)?,
            Command::Change(id, change) => {
                self.send_json(&format!("{STAMPS}/cards/{id}"), change)?
            }
        };
        read_response_with(response, review_transport_error)
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
