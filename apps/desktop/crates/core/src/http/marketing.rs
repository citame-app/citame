use super::*;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Channel {
    Email,
    Sms,
    Optimized,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
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

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct EmailLayout {
    pub heading: String,
    pub preheader: String,
    pub blocks: Vec<EmailBlock>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EmailBlock {
    Heading {
        text: String,
    },
    Paragraph {
        text: String,
        emphasis: EmailEmphasis,
    },
    Booking {
        label: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EmailEmphasis {
    None,
    Strong,
    Italic,
}

impl EmailLayout {
    pub const BODY_LIMIT: usize = 10_000;
    pub const HEADING_LIMIT: usize = 140;
    pub const PREHEADER_LIMIT: usize = 150;
    pub const BOOKING_LIMIT: usize = 80;
    pub const BLOCK_LIMIT: usize = 16;

    pub fn plain_text(&self) -> String {
        [&self.heading, &self.preheader]
            .into_iter()
            .cloned()
            .chain(self.blocks.iter().map(|block| match block {
                EmailBlock::Heading { text } | EmailBlock::Paragraph { text, .. } => text.clone(),
                EmailBlock::Booking { label } => format!("{label}: {{{{booking_url}}}}"),
            }))
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n")
    }

    pub fn has_booking_link(&self) -> bool {
        self.heading.contains("{{booking_url}}")
            || self.blocks.iter().any(|block| match block {
                EmailBlock::Booking { .. } => true,
                EmailBlock::Heading { text } | EmailBlock::Paragraph { text, .. } => {
                    text.contains("{{booking_url}}")
                }
            })
    }

    pub fn is_valid(&self) -> bool {
        let fits = |text: &str, limit| text.encode_utf16().count() <= limit && !text.contains('\0');
        fits(&self.heading, Self::HEADING_LIMIT)
            && fits(&self.preheader, Self::PREHEADER_LIMIT)
            && (1..=Self::BLOCK_LIMIT).contains(&self.blocks.len())
            && self.blocks.iter().all(|block| {
                let (text, limit) = match block {
                    EmailBlock::Heading { text } => (text, Self::HEADING_LIMIT),
                    EmailBlock::Paragraph { text, .. } => (text, Self::BODY_LIMIT),
                    EmailBlock::Booking { label } => (label, Self::BOOKING_LIMIT),
                };
                !text.is_empty() && fits(text, limit)
            })
            && self.plain_text().encode_utf16().count() <= Self::BODY_LIMIT
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
    pub email_layout: Option<EmailLayout>,
    pub sms_body: String,
    pub delay_minutes: u32,
    pub birthday_lead_days: u32,
    pub scheduled_for: Option<DateTime<Utc>>,
    pub audience: Audience,
    pub counts: Counts,
    #[serde(default)]
    pub selected_contacts: Vec<InvitationContact>,
}

#[derive(Clone, Deserialize)]
pub struct InvitationContact {
    pub id: String,
    pub name: String,
}

// Matches BOOKING_INVITATION_MAX_CONTACTS in the shared campaign contract.
pub const MAX_INVITATION_CONTACTS: usize = 100;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Audience {
    pub tags: Vec<String>,
    pub no_future_appointments: bool,
    pub inactive_days: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_client_ids: Option<Vec<String>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub name: String,
    pub channel: Channel,
    pub trigger: Trigger,
    pub subject: String,
    pub email_body: String,
    /// An omitted field preserves an existing layout. Explicit null converts it to plain text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email_layout: Option<Option<Box<EmailLayout>>>,
    pub sms_body: String,
    pub delay_minutes: u32,
    pub birthday_lead_days: u32,
    pub audience: Audience,
}

impl Draft {
    pub fn from_template(trigger: Trigger, name: &str, subject: &str, message: &str) -> Self {
        let inactive = trigger == Trigger::Inactive;
        Self {
            name: name.into(),
            channel: Channel::Email,
            trigger,
            subject: subject.into(),
            email_body: message.into(),
            email_layout: None,
            sms_body: message.into(),
            delay_minutes: if trigger == Trigger::FirstVisit {
                120
            } else {
                0
            },
            birthday_lead_days: 0,
            audience: Audience {
                tags: Vec::new(),
                inactive_days: inactive.then_some(60),
                no_future_appointments: inactive,
                selected_client_ids: None,
            },
        }
    }

    pub fn duplicate(campaign: &Campaign, copy_label: &str) -> Self {
        let mut draft = Self::from(campaign);
        let suffix = format!(" · {copy_label}");
        let mut remaining = 160usize.saturating_sub(suffix.encode_utf16().count());
        draft.name = campaign
            .name
            .chars()
            .take_while(|character| {
                let Some(next) = remaining.checked_sub(character.len_utf16()) else {
                    return false;
                };
                remaining = next;
                true
            })
            .collect();
        draft.name.push_str(&suffix);
        draft
    }
}

impl From<&Campaign> for Draft {
    fn from(campaign: &Campaign) -> Self {
        Self {
            name: campaign.name.clone(),
            channel: campaign.channel,
            trigger: campaign.trigger,
            subject: campaign.subject.clone(),
            email_body: campaign.email_body.clone(),
            email_layout: campaign
                .email_layout
                .clone()
                .map(|layout| Some(Box::new(layout))),
            sms_body: campaign.sms_body.clone(),
            delay_minutes: campaign.delay_minutes,
            birthday_lead_days: campaign.birthday_lead_days,
            audience: campaign.audience.clone(),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(untagged)]
pub enum DraftRevision {
    Create {
        id: String,
    },
    Edit {
        #[serde(skip)]
        id: String,
        version: u32,
    },
}

#[derive(Clone, Serialize)]
pub struct DraftWrite {
    #[serde(skip)]
    pub generation: String,
    #[serde(flatten)]
    pub revision: DraftRevision,
    #[serde(flatten)]
    pub draft: Draft,
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
#[serde(rename_all = "camelCase")]
pub struct CampaignComparison {
    pub campaigns: Vec<ComparedCampaign>,
}

#[derive(Deserialize)]
pub struct ComparedCampaign {
    pub name: String,
    pub channel: Channel,
    pub status: Status,
    pub counts: Counts,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CampaignPage {
    pub campaigns: Vec<Campaign>,
    pub pagination: Pagination,
    #[serde(default)]
    pub booking_invitations: bool,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Delivery {
    pub id: String,
    pub client_name: String,
    pub channel: Channel,
    pub status: DeliveryStatus,
    pub created_at: DateTime<Utc>,
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
    #[serde(default, rename = "canTestEmail")]
    pub can_test_email: bool,
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

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TestEmailStatus {
    Accepted,
    Pending,
    Unconfirmed,
    Rejected,
    NotRequested,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TestEmailMode {
    Send,
    Check,
    ReplaceUnconfirmed,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TestEmailReceipt {
    pub status: TestEmailStatus,
    pub request_id: uuid::Uuid,
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
            .append_pair("bookingInvitations", "1")
            .append_pair("emailLayout", "1")
            .append_pair("search", search);
        if let Some(status) = status {
            params.append_pair("status", status.wire());
        }
        read_response(
            self.get(&self.agent, &format!("{PATH}?{}", params.finish()), None)?,
            false,
        )
    }

    pub fn marketing_campaign_comparison(
        &self,
        ids: &[String],
    ) -> Result<CampaignComparison, TransportError> {
        let ids = ids
            .iter()
            .map(|id| parse_id(id).map(|id| id.to_string()))
            .collect::<Result<Vec<_>, _>>()?;
        let mut params = form_urlencoded::Serializer::new(String::new());
        params.append_pair("ids", &ids.join(","));
        read_response(
            self.get(
                &self.agent,
                &format!("{PATH}/comparison?{}", params.finish()),
                None,
            )?,
            false,
        )
    }

    pub fn marketing_campaign(&self, id: &str) -> Result<Campaign, TransportError> {
        read_response(
            self.get(
                &self.agent,
                &format!("{PATH}/{}?emailLayout=1", parse_id(id)?),
                None,
            )?,
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
        let req = self
            .agent
            .post(&format!("{}{PATH}/{id}/{endpoint}", self.base_url));
        self.send_campaign_write(req, &action.generation, body)
    }

    pub fn send_campaign_test_email(
        &self,
        campaign_id: &str,
        generation: &str,
        version: u32,
        request_id: uuid::Uuid,
        mode: TestEmailMode,
    ) -> Result<TestEmailReceipt, MutationError> {
        let id = parse_id(campaign_id)?;
        let req = self
            .agent
            .post(&format!("{}{PATH}/{id}/test-email", self.base_url));
        let body = serde_json::json!({ "version": version, "requestId": request_id, "mode": mode });
        self.send_campaign_write(req, generation, body.to_string())
    }

    pub fn save_campaign_draft(&self, write: &DraftWrite) -> Result<Campaign, MutationError> {
        let body =
            serde_json::to_string(write).map_err(|e| TransportError::BadRequest(e.to_string()))?;
        let req = match &write.revision {
            DraftRevision::Create { id } => {
                parse_id(id)?;
                self.agent.post(&format!("{}{PATH}", self.base_url))
            }
            DraftRevision::Edit { id, .. } => {
                self.agent
                    .patch(&format!("{}{PATH}/{}", self.base_url, parse_id(id)?))
            }
        };
        self.send_campaign_write(req, &write.generation, body)
    }

    fn send_campaign_write<T: DeserializeOwned>(
        &self,
        mut req: ureq::RequestBuilder<ureq::typestate::WithBody>,
        generation: &str,
        body: String,
    ) -> Result<T, MutationError> {
        for (key, value) in self.headers()? {
            req = req.header(key, value);
        }
        let response = req
            .header("x-citame-generation", generation)
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
                _ => review_transport_error(status, retry_after, body).into(),
            }
        })
    }
}
