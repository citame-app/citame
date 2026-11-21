use super::*;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use url::form_urlencoded;

const PATH: &str = "/admin/marketing/campaigns";
pub const LIVE_TOPIC: &str = "marketing";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Draft,
    Scheduled,
    Active,
    Completed,
    Cancelled,
}

impl Status {
    pub fn wire(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Scheduled => "scheduled",
            Self::Active => "active",
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Channel {
    Email,
    Sms,
    Optimized,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Trigger {
    Manual,
    FirstVisit,
    Inactive,
    Birthday,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryStatus {
    Pending,
    Processing,
    Sent,
    Skipped,
    Failed,
    Unknown,
    Cancelled,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pagination {
    pub page: u32,
    pub page_size: u32,
    pub total: u32,
}

impl Pagination {
    pub fn has_next(&self) -> bool {
        self.page.saturating_mul(self.page_size) < self.total
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Campaign {
    pub id: String,
    pub name: String,
    pub channel: Channel,
    pub trigger: Trigger,
    pub status: Status,
    pub version: u32,
    pub subject: String,
    pub email_body: String,
    pub sms_body: String,
    pub scheduled_for: Option<DateTime<Utc>>,
    pub audience: Audience,
    pub counts: Counts,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Audience {
    pub tags: Vec<String>,
    pub no_future_appointments: bool,
    pub inactive_days: Option<u32>,
}

#[derive(Clone, Deserialize)]
pub struct Counts {
    pub pending: u32,
    pub processing: u32,
    pub sent: u32,
    pub skipped: u32,
    pub failed: u32,
    pub unknown: u32,
    pub cancelled: u32,
}

#[derive(Deserialize)]
pub struct CampaignPage {
    pub campaigns: Vec<Campaign>,
    pub pagination: Pagination,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Delivery {
    pub id: String,
    pub client_name: String,
    pub channel: Channel,
    pub status: DeliveryStatus,
    pub sent_at: Option<DateTime<Utc>>,
}

#[derive(Deserialize)]
pub struct DeliveryPage {
    pub deliveries: Vec<Delivery>,
    pub pagination: Pagination,
}

#[derive(Deserialize)]
pub struct Capabilities {
    pub email: bool,
    pub sms: bool,
    pub worker: bool,
}

impl Capabilities {
    pub fn can_deliver(&self, channel: Channel) -> bool {
        self.worker
            && match channel {
                Channel::Email => self.email,
                Channel::Sms => self.sms,
                Channel::Optimized => self.email || self.sms,
            }
    }
}

#[derive(Clone, Deserialize)]
pub struct AudienceSample {
    pub name: String,
    pub channel: Channel,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub campaign_id: String,
    pub version: u32,
    pub audience_hash: String,
    pub eligible: u32,
    pub email: u32,
    pub sms: u32,
    pub excluded: u32,
    pub sample: Vec<AudienceSample>,
}

#[derive(Clone)]
pub struct CampaignAction {
    pub campaign_id: String,
    pub generation: String,
    action: Action,
}

#[derive(Clone, Serialize)]
#[serde(untagged)]
enum Action {
    Queue(Queue),
    Cancel(Cancel),
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Queue {
    version: u32,
    audience_hash: String,
    scheduled_for: Option<DateTime<Utc>>,
}

#[derive(Clone, Serialize)]
struct Cancel {
    version: u32,
}

impl CampaignAction {
    pub fn queue(
        campaign: &Campaign,
        preview: &Preview,
        generation: String,
        scheduled_for: Option<DateTime<Utc>>,
    ) -> Option<Self> {
        if campaign.status != Status::Draft
            || preview.campaign_id != campaign.id
            || preview.version != campaign.version
            || (campaign.trigger == Trigger::Manual && preview.eligible == 0)
        {
            return None;
        }
        Some(Self {
            campaign_id: campaign.id.clone(),
            generation,
            action: Action::Queue(Queue {
                version: preview.version,
                audience_hash: preview.audience_hash.clone(),
                scheduled_for,
            }),
        })
    }

    pub fn cancel(campaign: &Campaign, generation: String) -> Option<Self> {
        matches!(campaign.status, Status::Scheduled | Status::Active).then(|| Self {
            campaign_id: campaign.id.clone(),
            generation,
            action: Action::Cancel(Cancel {
                version: campaign.version,
            }),
        })
    }

    pub fn is_cancel(&self) -> bool {
        matches!(self.action, Action::Cancel(_))
    }

    pub fn scheduled_for(&self) -> Option<DateTime<Utc>> {
        match &self.action {
            Action::Queue(queue) => queue.scheduled_for,
            Action::Cancel(_) => None,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum MutationError {
    #[error("campaign or audience changed")]
    Changed,
    #[error("campaign delivery was rejected")]
    Rejected,
    #[error(transparent)]
    Transport(#[from] TransportError),
}

impl HttpTransport {
    pub fn marketing_campaigns(
        &self,
        page: u32,
        search: &str,
        status: Option<Status>,
    ) -> Result<CampaignPage, TransportError> {
        let mut params = form_urlencoded::Serializer::new(String::new());
        params
            .append_pair("page", &page.to_string())
            .append_pair("search", search);
        if let Some(status) = status {
            params.append_pair("status", status.wire());
        }
        read_response(
            self.get(&self.agent, &format!("{PATH}?{}", params.finish()), None)?,
            false,
        )
    }

    pub fn marketing_campaign(&self, id: &str) -> Result<Campaign, TransportError> {
        read_response(
            self.get(&self.agent, &format!("{PATH}/{}", parse_id(id)?), None)?,
            false,
        )
    }

    pub fn marketing_deliveries(
        &self,
        id: &str,
        page: u32,
    ) -> Result<DeliveryPage, TransportError> {
        read_response(
            self.get(
                &self.agent,
                &format!("{PATH}/{}/deliveries?page={page}", parse_id(id)?),
                None,
            )?,
            false,
        )
    }

    pub fn marketing_preview(&self, id: &str) -> Result<Preview, TransportError> {
        read_response(
            self.get(
                &self.agent,
                &format!("{PATH}/{}/preview", parse_id(id)?),
                None,
            )?,
            false,
        )
    }

    pub fn marketing_capabilities(&self) -> Result<Capabilities, TransportError> {
        read_response(
            self.get(&self.agent, "/admin/marketing/capabilities", None)?,
            false,
        )
    }

    pub fn act_on_campaign(&self, action: &CampaignAction) -> Result<Campaign, MutationError> {
        let body = serde_json::to_string(&action.action)
            .map_err(|e| TransportError::BadRequest(e.to_string()))?;
        let id = parse_id(&action.campaign_id)?;
        let endpoint = if action.is_cancel() {
            "cancel"
        } else {
            "queue"
        };
        let mut req = self
            .agent
            .post(&format!("{}{PATH}/{id}/{endpoint}", self.base_url));
        for (key, value) in self.headers()? {
            req = req.header(key, value);
        }
        let response = req
            .header("x-citame-generation", &action.generation)
            .content_type("application/json")
            .send(body)
            .map_err(|error| TransportError::Offline(error.to_string()))?;
        read_response_with(response, |status, retry_after, body| {
            let detail = serde_json::from_str::<serde_json::Value>(body).ok();
            let code = detail
                .as_ref()
                .and_then(|value| value.pointer("/error/code"))
                .and_then(serde_json::Value::as_str);
            match (status, code) {
                (409, Some("version_conflict")) => MutationError::Changed,
                (400, Some("validation_error")) | (409, Some("invalid_state")) => {
                    MutationError::Rejected
                }
                _ => classify_status(status, retry_after, body, false).into(),
            }
        })
    }
}
