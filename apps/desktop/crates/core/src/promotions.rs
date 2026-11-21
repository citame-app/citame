use chrono::{DateTime, NaiveDateTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const LIVE_TOPIC: &str = "promotions";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Discount {
    Percent,
    Fixed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Eligible {
    Service,
    Product,
    Custom,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Timing {
    pub weekdays: Vec<u8>,
    pub start_minute: u16,
    pub end_minute: u16,
    pub last_minute_hours: Option<u16>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Terms {
    pub code: String,
    pub name: String,
    pub kind: Discount,
    pub value: u32,
    pub minimum_spend_cents: u32,
    pub maximum_discount_cents: Option<u32>,
    pub usage_limit: Option<u32>,
    pub per_client_limit: Option<u32>,
    pub starts_at: Option<DateTime<Utc>>,
    pub ends_at: Option<DateTime<Utc>>,
    pub eligible_kinds: Vec<Eligible>,
    pub service_ids: Vec<Uuid>,
    pub active: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timing: Option<Timing>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Promotion {
    pub id: Uuid,
    pub version: u32,
    pub used_count: u32,
    #[serde(flatten)]
    pub terms: Terms,
}

#[derive(Deserialize)]
pub struct PromotionsPage {
    pub promotions: Vec<Promotion>,
    pub pagination: crate::http::marketing::Pagination,
}

#[derive(Clone)]
pub struct SavePromotion {
    pub revision: Option<(Uuid, u32)>,
    pub generation: String,
    pub terms: Terms,
}

#[derive(Debug, thiserror::Error)]
pub enum PromotionWriteError {
    #[error("promotion changed")]
    Conflict,
    #[error(transparent)]
    Transport(#[from] crate::sync::TransportError),
}

impl Terms {
    pub fn valid(&self) -> bool {
        let code = self.code.as_bytes();
        if !(3..=40).contains(&code.len())
            || !code[0].is_ascii_alphanumeric()
            || !code.iter().all(|byte| {
                byte.is_ascii_uppercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')
            })
            || self.name.is_empty()
            || self.name.encode_utf16().count() > 100
            || self.value == 0
            || self.value > 999999999
            || (self.kind == Discount::Percent && self.value > 10000)
            || self.minimum_spend_cents > 999999999
            || self
                .maximum_discount_cents
                .is_some_and(|cap| !(1..=999999999).contains(&cap))
            || [self.usage_limit, self.per_client_limit]
                .into_iter()
                .flatten()
                .any(|limit| !(1..=1000000).contains(&limit))
            || self
                .starts_at
                .zip(self.ends_at)
                .is_some_and(|(start, end)| start >= end)
            || self.eligible_kinds.is_empty()
            || self.service_ids.len() > 100
        {
            return false;
        }
        self.timing.as_ref().is_none_or(|timing| {
            self.eligible_kinds == [Eligible::Service]
                && !timing.weekdays.is_empty()
                && timing.weekdays.iter().all(|day| (1..=7).contains(day))
                && timing.start_minute < timing.end_minute
                && timing.end_minute <= 1440
                && timing
                    .last_minute_hours
                    .is_none_or(|hours| (1..=168).contains(&hours))
        })
    }
}

pub fn local_input(zone: chrono_tz::Tz, instant: Option<DateTime<Utc>>) -> String {
    instant
        .map(|value| {
            value
                .with_timezone(&zone)
                .format("%Y-%m-%d %H:%M")
                .to_string()
        })
        .unwrap_or_default()
}

pub fn parse_instant(
    zone: chrono_tz::Tz,
    text: &str,
    original: Option<DateTime<Utc>>,
) -> Option<Option<DateTime<Utc>>> {
    let text = text.trim();
    if text.is_empty() {
        return Some(None);
    }
    if original.is_some() && text == local_input(zone, original) {
        return Some(original);
    }
    let naive = NaiveDateTime::parse_from_str(text, "%Y-%m-%d %H:%M").ok()?;
    zone.from_local_datetime(&naive)
        .single()
        .map(|date| Some(date.with_timezone(&Utc)))
}

pub fn parse_minute(text: &str, allow_end_of_day: bool) -> Option<u16> {
    let (hour, minute) = text.trim().split_once(':')?;
    if hour.len() != 2 || minute.len() != 2 {
        return None;
    }
    let hour: u16 = hour.parse().ok()?;
    let minute: u16 = minute.parse().ok()?;
    if (hour < 24 && minute < 60) || (allow_end_of_day && hour == 24 && minute == 0) {
        Some(hour * 60 + minute)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn promotion_intervals_keep_existing_instants_and_reject_invalid_wall_times() {
        let madrid = chrono_tz::Europe::Madrid;
        assert_eq!(parse_instant(madrid, "2026-03-29 02:30", None), None);
        assert_eq!(parse_instant(madrid, "2026-10-25 02:30", None), None);
        let existing = "2026-10-25T01:30:25Z".parse().unwrap();
        assert_eq!(
            parse_instant(madrid, "2026-10-25 02:30", Some(existing)),
            Some(Some(existing))
        );
        assert_eq!(parse_minute("24:00", false), None);
        assert_eq!(parse_minute("24:00", true), Some(1440));
        assert_eq!(parse_minute("24:01", true), None);
    }
}
