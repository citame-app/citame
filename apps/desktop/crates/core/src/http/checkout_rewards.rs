use super::*;
use crate::loyalty::checkout::{Application, Choice, Quote, ReturnPoints, RewardError, RewardKind};

impl HttpTransport {
    pub fn quote_checkout_reward(
        &self,
        receipt: &AppointmentCheckout,
        choice: &Choice,
    ) -> Result<Quote, RewardError> {
        let id = parse_id(&receipt.id)?;
        let response = self.send_json(
            &format!("/admin/commerce/checkouts/{id}/reward/quote"),
            choice,
        )?;
        read_response_with(response, classify_reward_error)
    }

    pub fn apply_checkout_reward(
        &self,
        receipt: &AppointmentCheckout,
        application: &Application,
        generation: &str,
    ) -> Result<AppointmentCheckout, RewardError> {
        self.write_checkout_reward(receipt, "", application, generation, |ack| {
            ack.reward
                .as_ref()
                .is_some_and(|reward| application.acknowledges(reward))
        })
    }

    pub fn return_checkout_points(
        &self,
        receipt: &AppointmentCheckout,
        submission: &ReturnPoints,
        generation: &str,
    ) -> Result<AppointmentCheckout, RewardError> {
        self.write_checkout_reward(receipt, "/return", submission, generation, |ack| {
            ack.reward.as_ref().is_some_and(|reward| {
                reward.kind == RewardKind::Points
                    && reward.points_used > 0
                    && reward.returned_points == reward.points_used
            })
        })
    }

    fn write_checkout_reward(
        &self,
        receipt: &AppointmentCheckout,
        suffix: &str,
        input: &impl serde::Serialize,
        generation: &str,
        confirmed: impl FnOnce(&AppointmentCheckout) -> bool,
    ) -> Result<AppointmentCheckout, RewardError> {
        let id = parse_id(&receipt.id)?;
        let path = format!("/admin/commerce/checkouts/{id}/reward{suffix}");
        let response =
            self.send_json_with_headers(&path, input, &[("x-citame-generation", generation)])?;
        let ack: AppointmentCheckout = read_response_with(response, classify_reward_error)?;
        if parse_id(&ack.id).ok() != Some(id) || !confirmed(&ack) {
            return Err(TransportError::Server("Unexpected reward acknowledgement".into()).into());
        }
        // The common reward writes serve both staff and customers. Reload the staff view
        // to keep permission metadata, including the available refund actions.
        self.refresh_checkout(receipt).map_err(|_| {
            TransportError::Server("The confirmed receipt could not be refreshed".into()).into()
        })
    }
}

fn classify_reward_error(status: u16, retry_after: Option<&str>, body: &str) -> RewardError {
    let envelope = serde_json::from_str::<serde_json::Value>(body).ok();
    match envelope
        .as_ref()
        .and_then(|json| json.pointer("/error/code"))
        .and_then(serde_json::Value::as_str)
    {
        Some("version_conflict" | "invalid_state") if status == 409 => RewardError::Conflict,
        Some("promotion_timing_mismatch") => RewardError::Timing,
        _ => review_transport_error(status, retry_after, body).into(),
    }
}
