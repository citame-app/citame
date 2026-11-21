use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    Expired,
    Completed,
    All,
}

impl Scope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Expired => "expired",
            Self::Completed => "completed",
            Self::All => "all",
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub scope: Scope,
    pub generation: String,
    pub review_fingerprint: String,
    pub total: u32,
    pub counts: Counts,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Counts {
    pub active: u32,
    pub completed: u32,
    pub issued: u32,
    pub expired: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub scope: Scope,
    pub generation: String,
    pub review_fingerprint: String,
    pub reason: String,
    pub idempotency_key: Uuid,
    #[serde(skip)]
    pub expected_total: u32,
}

impl Review {
    pub fn prepare(&self, reason: &str) -> Option<Request> {
        let reason = crate::trim_like_javascript(reason);
        if self.total == 0
            || !(8..=300).contains(&reason.encode_utf16().count())
            || reason.contains('\0')
        {
            return None;
        }
        Some(Request {
            scope: self.scope,
            generation: self.generation.clone(),
            review_fingerprint: self.review_fingerprint.clone(),
            reason: reason.to_owned(),
            idempotency_key: Uuid::now_v7(),
            expected_total: self.total,
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Result {
    pub scope: Scope,
    pub generation: String,
    pub idempotency_key: Uuid,
    pub total: u32,
    pub voided_at: DateTime<Utc>,
}

impl Request {
    pub fn acknowledges(&self, result: &Result) -> bool {
        self.scope == result.scope
            && self.generation == result.generation
            && self.idempotency_key == result.idempotency_key
            && self.expected_total == result.total
    }
}
