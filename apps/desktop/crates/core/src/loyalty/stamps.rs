use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

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

#[derive(Clone, Deserialize)]
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

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reward {
    pub name: String,
    pub discount_basis_points: Option<u32>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
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
