use crate::sync::TransportError;
use chrono::{DateTime, NaiveDate, TimeZone, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use uuid::Uuid;

pub mod programme;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cards {
    pub cards: Vec<Card>,
    pub generation: String,
    pub program_version: u32,
    pub program: Terms,
    #[serde(default)]
    pub can_edit: bool,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    pub version: u32,
    pub id: Uuid,
    pub program: Terms,
    pub stamps: u32,
    pub state: State,
    pub needs_review: bool,
    pub stamp_expires_at: Option<DateTime<Utc>>,
    pub reward_expires_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
    pub reward_issued_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Terms {
    pub enabled: bool,
    pub welcome_stamps: u32,
    pub name: String,
    pub appearance: Appearance,
    pub goal: u32,
    pub terms: String,
    pub reward: Reward,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reward {
    pub kind: RewardKind,
    pub name: String,
    pub discount_basis_points: Option<u32>,
    pub target_id: Option<Uuid>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Appearance {
    Neutral,
    Rose,
    Mint,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Active,
    Queued,
    Completed,
    Issued,
    Redeemed,
    Expired,
    Void,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub generation: String,
    pub idempotency_key: Uuid,
    pub client_id: Uuid,
    pub program_version: u32,
    pub initial_stamps: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub generation: String,
    pub idempotency_key: Uuid,
    pub version: u32,
    #[serde(flatten)]
    pub action: Action,
}

#[derive(Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Action {
    Edit {
        stamps: u32,
        expires_at: Option<DateTime<Utc>>,
        reason: String,
    },
    IssueReward,
    Redeem,
    Void {
        reason: String,
    },
}

#[derive(Clone)]
pub enum Command {
    Issue(Issue),
    Change(Uuid, Change),
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RewardKind {
    Service,
    Product,
    Other,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Operation {
    Issue,
    Edit,
    IssueReward,
    Redeem,
    Void,
}

impl Operation {
    pub fn show_count(self) -> bool {
        matches!(self, Self::Issue | Self::Edit)
    }

    pub fn show_reason(self) -> bool {
        matches!(self, Self::Edit | Self::Void)
    }

    pub fn can_apply(self, card: &Card) -> bool {
        match self {
            Self::Issue => false,
            Self::Edit => {
                card.reward_issued_at.is_none()
                    && matches!(
                        card.state,
                        State::Active | State::Queued | State::Completed | State::Expired
                    )
            }
            Self::IssueReward => card.state == State::Completed && !card.needs_review,
            Self::Redeem => card.state == State::Issued && !card.needs_review,
            Self::Void => !matches!(card.state, State::Void | State::Redeemed),
        }
    }
}

pub struct Draft<'a> {
    pub operation: Operation,
    pub client: Uuid,
    pub card: Option<&'a Card>,
    pub generation: &'a str,
    pub program_version: u32,
    pub goal: u32,
    pub stamps: &'a str,
    pub expiry: &'a str,
    pub reason: &'a str,
}
pub fn expiry_date(value: DateTime<Utc>, tz: Tz) -> String {
    (value - chrono::Duration::milliseconds(1))
        .with_timezone(&tz)
        .format("%Y-%m-%d")
        .to_string()
}

fn end_of_day(value: &str, tz: Tz) -> Option<DateTime<Utc>> {
    let day = NaiveDate::parse_from_str(value, "%Y-%m-%d").ok()?;
    let midnight = day.succ_opt()?.and_hms_opt(0, 0, 0)?;
    // Choose the earlier boundary if midnight occurs twice.
    tz.from_local_datetime(&midnight)
        .earliest()
        .map(|value| value.with_timezone(&Utc))
}

impl Draft<'_> {
    pub fn prepare(&self, tz: Tz) -> Option<Command> {
        let generation = self.generation.to_owned();
        let idempotency_key = Uuid::now_v7();
        let stamps = if self.operation.show_count() {
            let raw = self.stamps.trim();
            if !raw.bytes().all(|digit| digit.is_ascii_digit()) {
                return None;
            }
            raw.parse::<u32>()
                .ok()
                .filter(|count| *count <= self.goal)?
        } else {
            0
        };
        let expiry = self.expiry.trim();
        let original = self.card.and_then(|card| card.stamp_expires_at);
        let expires_at = if expiry.is_empty() {
            None
        } else if original.is_some_and(|value| expiry_date(value, tz) == expiry) {
            original
        } else {
            Some(end_of_day(expiry, tz)?)
        };
        let reason = self.reason.trim();
        if self.operation.show_reason() && !(8..=300).contains(&reason.encode_utf16().count()) {
            return None;
        }
        let Some(card) = self.card else {
            if self.operation != Operation::Issue {
                return None;
            }
            return Some(Command::Issue(Issue {
                generation,
                idempotency_key,
                client_id: self.client,
                program_version: self.program_version,
                initial_stamps: stamps,
                expires_at,
            }));
        };
        let action = match self.operation {
            Operation::Issue => return None,
            Operation::Edit => Action::Edit {
                stamps,
                expires_at,
                reason: reason.to_owned(),
            },
            Operation::IssueReward => Action::IssueReward,
            Operation::Redeem => Action::Redeem,
            Operation::Void => Action::Void {
                reason: reason.to_owned(),
            },
        };
        Some(Command::Change(
            card.id,
            Change {
                generation,
                idempotency_key,
                version: card.version,
                action,
            },
        ))
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RewardNotice {
    pub card_id: Uuid,
    pub client_id: Option<Uuid>,
    pub client_name: Option<String>,
    pub card_name: String,
    pub reward_name: String,
    pub earned_at: DateTime<Utc>,
    pub revision: u32,
    pub reward_expires_at: Option<DateTime<Utc>>,
    pub issued: bool,
    pub read: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RewardNotices {
    pub generation: String,
    pub unread_count: u32,
    pub entries: Vec<RewardNotice>,
    pub page: u32,
    pub page_size: u32,
    pub total: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RewardNoticeRead {
    pub generation: String,
    pub card_id: Uuid,
    pub revision: u32,
}

pub const NOTICE_REFRESH_INTERVAL: Duration = Duration::from_secs(20);

pub fn notice_retry_delay(error: Option<&TransportError>) -> Option<Duration> {
    match error {
        Some(TransportError::RateLimited(wait)) => Some(
            wait.unwrap_or(NOTICE_REFRESH_INTERVAL)
                .max(Duration::from_secs(1)),
        ),
        _ => None,
    }
}

pub struct RewardInboxReply {
    pub listing: Result<RewardNotices, TransportError>,
    pub read_error: Option<TransportError>,
}
