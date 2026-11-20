//! The live review invitation desk shares the web API and its one-delivery-per-visit guarantee.

use chrono::{DateTime, Utc};
use serde::Deserialize;
use url::form_urlencoded;

pub const MAX_PAGE: u32 = 10_000;
pub const LIVE_TOPIC: &str = "review_requests";
const MAX_SEARCH_LENGTH: usize = 100;

pub(crate) fn requests_path(page: u32, search: &str) -> String {
    let mut remaining = MAX_SEARCH_LENGTH;
    let term: String = search
        .trim()
        .chars()
        .take_while(|character| {
            let Some(space) = remaining.checked_sub(character.len_utf16()) else {
                return false;
            };
            remaining = space;
            true
        })
        .collect();
    let query = form_urlencoded::Serializer::new(String::new())
        .append_pair("page", &page.to_string())
        .append_pair("search", &term)
        .finish();
    format!("/admin/reviews/requests?{query}")
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EmailStatus {
    Pending,
    Processing,
    Sent,
    Skipped,
    Failed,
    Unknown,
    Cancelled,
}

impl EmailStatus {
    pub fn is_pending(self) -> bool {
        matches!(self, Self::Pending | Self::Processing)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewVisit {
    pub appointment_id: String,
    pub starts_at: DateTime<Utc>,
    pub client_name: String,
    pub link: Option<String>,
    #[serde(default)]
    pub can_email: bool,
    pub email_status: Option<EmailStatus>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRequests {
    pub visits: Vec<ReviewVisit>,
    pub has_more: bool,
    #[serde(default)]
    pub email_enabled: bool,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ReviewEmail {
    pub status: EmailStatus,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReviewStatus {
    Pending,
    Published,
    Hidden,
    Withdrawn,
}

impl ReviewStatus {
    fn value(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Published => "published",
            Self::Hidden => "hidden",
            Self::Withdrawn => "withdrawn",
        }
    }
}

pub(crate) fn moderation_path(status: Option<ReviewStatus>, before: Option<&str>) -> String {
    let mut query = form_urlencoded::Serializer::new(String::new());
    if let Some(status) = status {
        query.append_pair("status", status.value());
    }
    if let Some(before) = before {
        query.append_pair("before", before);
    }
    format!("/admin/reviews?{}", query.finish())
}

#[derive(Clone, Debug, Deserialize)]
pub struct ReviewService {
    pub name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModerationCommand<'a> {
    Publish,
    Hide(&'a str),
    Reply(Option<&'a str>),
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ModerationMode {
    Publish,
    Hide,
    Reply,
}

impl ModerationMode {
    pub fn allows(self, review: &ManagedReview) -> bool {
        if review.status == ReviewStatus::Withdrawn {
            return false;
        }
        match self {
            Self::Publish => review.source_eligible && review.status != ReviewStatus::Published,
            Self::Hide => true,
            Self::Reply => review.source_eligible && review.status == ReviewStatus::Published,
        }
    }

    pub fn draft(self, review: &ManagedReview) -> &str {
        match self {
            Self::Publish => "",
            Self::Hide => review.moderation_reason.as_deref().unwrap_or(""),
            Self::Reply => review.reply.as_deref().unwrap_or(""),
        }
    }

    pub fn command(self, text: &str) -> Option<ModerationCommand<'_>> {
        let text = text.trim();
        match self {
            Self::Publish => Some(ModerationCommand::Publish),
            Self::Hide if !text.is_empty() && valid_moderation_text(text, 300) => {
                Some(ModerationCommand::Hide(text))
            }
            Self::Reply if valid_moderation_text(text, 1000) => {
                Some(ModerationCommand::Reply((!text.is_empty()).then_some(text)))
            }
            _ => None,
        }
    }
}

impl ModerationCommand<'_> {
    pub(crate) fn payload(self, version: u32) -> (&'static str, serde_json::Value) {
        match self {
            Self::Publish => (
                "moderation",
                serde_json::json!({ "version": version, "status": "published" }),
            ),
            Self::Hide(reason) => (
                "moderation",
                serde_json::json!({ "version": version, "status": "hidden", "reason": reason }),
            ),
            Self::Reply(reply) => (
                "reply",
                serde_json::json!({ "version": version, "reply": reply }),
            ),
        }
    }
}

fn valid_moderation_text(text: &str, max: usize) -> bool {
    text.trim().encode_utf16().count() <= max
        && !text.chars().any(|character| {
            matches!(character, '\u{0000}'..='\u{0008}' | '\u{000b}' | '\u{000c}' | '\u{000e}'..='\u{001f}' | '\u{007f}')
        })
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedReview {
    pub id: String,
    pub public_name: Option<String>,
    pub rating: Option<u8>,
    pub body: Option<String>,
    pub services: Vec<ReviewService>,
    pub status: ReviewStatus,
    pub moderation_reason: Option<String>,
    pub reply: Option<String>,
    pub version: u32,
    pub source_eligible: bool,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPage {
    pub reviews: Vec<ManagedReview>,
    pub next_before: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_is_encoded_and_bounded_without_splitting_unicode() {
        assert_eq!(
            requests_path(2, " A&B "),
            "/admin/reviews/requests?page=2&search=A%26B"
        );
        assert_eq!(
            requests_path(1, &format!("{}🪷", "é".repeat(99))),
            requests_path(1, &"é".repeat(99)),
        );
    }
}
