use super::{Appearance, RewardKind, Terms};
use crate::billing::parse_reviewed_amount;
use crate::trim_like_javascript;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgrammeTerms {
    #[serde(flatten)]
    pub card: Terms,
    pub qualifying_service_ids: Vec<Uuid>,
    pub minimum_spend_cents: u32,
    pub stamp_expiry_days: Option<u32>,
    pub expiry_from: ExpiryFrom,
    pub reward_expiry_days: Option<u32>,
    pub automatic_issue: bool,
    pub award_on: AwardOn,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExpiryFrom {
    Issue,
    Activity,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AwardOn {
    Checkout,
    Appointment,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Programme {
    pub version: u32,
    pub generation: String,
    pub program: ProgrammeTerms,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExistingCards {
    #[default]
    Keep,
    Void,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    #[serde(flatten)]
    pub reviewed: Programme,
    pub existing_cards: ExistingCards,
}

impl Review {
    pub fn matches_successor(&self, current: &Programme) -> bool {
        self.reviewed.generation == current.generation
            && self.reviewed.version.checked_add(1) == Some(current.version)
            && self.reviewed.program == current.program
    }
}

#[derive(Clone, Copy)]
pub struct Fields<'a> {
    pub name: &'a str,
    pub goal: &'a str,
    pub welcome: &'a str,
    pub minimum: &'a str,
    pub stamp_expiry: &'a str,
    pub reward_name: &'a str,
    pub discount: &'a str,
    pub reward_expiry: &'a str,
    pub terms: &'a str,
}

fn integer(input: &str) -> Option<u32> {
    let value = trim_like_javascript(input);
    if !value.bytes().all(|digit| digit.is_ascii_digit()) {
        return None;
    }
    value.parse().ok()
}

fn optional<T>(input: &str, parse: impl FnOnce(&str) -> Option<T>) -> Option<Option<T>> {
    let input = trim_like_javascript(input);
    if input.is_empty() {
        Some(None)
    } else {
        parse(input).map(Some)
    }
}

fn text(input: &str, min: usize, max: usize) -> Option<String> {
    let input = trim_like_javascript(input);
    let size = input.encode_utf16().count();
    ((min..=max).contains(&size) && !input.contains('\0')).then(|| input.to_owned())
}

impl ProgrammeTerms {
    pub fn parse_fields(&self, fields: Fields<'_>) -> Option<Self> {
        let expiry = |input: &str| {
            optional(input, |value| {
                integer(value).filter(|days| (1..=3650).contains(days))
            })
        };
        let goal = integer(fields.goal).filter(|goal| (1..=15).contains(goal))?;
        let mut terms = self.clone();
        terms.card.name = text(fields.name, 1, 80)?;
        terms.card.goal = goal;
        terms.card.welcome_stamps = integer(fields.welcome).filter(|count| *count < goal)?;
        terms.minimum_spend_cents =
            parse_reviewed_amount(fields.minimum).filter(|amount| *amount <= 999_999_999)?;
        terms.stamp_expiry_days = expiry(fields.stamp_expiry)?;
        terms.card.reward.name = text(fields.reward_name, 1, 120)?;
        terms.card.reward.discount_basis_points = optional(fields.discount, |value| {
            parse_reviewed_amount(value).filter(|amount| (1..=10_000).contains(amount))
        })?;
        terms.reward_expiry_days = expiry(fields.reward_expiry)?;
        terms.card.terms = text(fields.terms, 0, 2_000)?;
        if terms.qualifying_service_ids.len() > 50
            || terms
                .qualifying_service_ids
                .iter()
                .collect::<HashSet<_>>()
                .len()
                != terms.qualifying_service_ids.len()
            || (terms.card.reward.kind == RewardKind::Other
                && terms.card.reward.target_id.is_some())
        {
            return None;
        }
        Some(terms)
    }
}

pub const APPEARANCES: [Appearance; 3] = [Appearance::Neutral, Appearance::Rose, Appearance::Mint];
pub const AWARD_MODES: [AwardOn; 2] = [AwardOn::Checkout, AwardOn::Appointment];
pub const EXPIRY_BASES: [ExpiryFrom; 2] = [ExpiryFrom::Issue, ExpiryFrom::Activity];
pub const REWARD_KINDS: [RewardKind; 3] =
    [RewardKind::Service, RewardKind::Product, RewardKind::Other];
