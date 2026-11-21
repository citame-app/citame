use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::{HttpTransport, TransportError, read_response};

const PATH: &str = "/admin/settings/desktop";
pub const SALON_SLOT_STEPS: [u32; 6] = [5, 10, 15, 20, 30, 60];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SalonConfiguration {
    pub name: String,
    pub timezone: String,
    pub slot_granularity_minutes: u32,
    pub min_notice_minutes: u32,
    pub max_days_ahead: u32,
    pub online_booking_enabled: bool,
    pub reminder_first_lead_minutes: Option<u32>,
    pub reminder_second_lead_minutes: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct ReviewedSalonConfiguration {
    #[serde(flatten)]
    pub settings: SalonConfiguration,
    pub revision: DateTime<Utc>,
    pub generation: String,
}

pub struct SalonConfigurationDraft<'a> {
    pub name: &'a str,
    pub timezone: &'a str,
    pub slot_step: u32,
    pub notice: &'a str,
    pub horizon: &'a str,
    pub online_booking: bool,
    pub first_reminder: &'a str,
    pub second_reminder: &'a str,
}

impl SalonConfigurationDraft<'_> {
    pub fn validated(self) -> Option<SalonConfiguration> {
        let name = self.name.trim();
        let timezone: chrono_tz::Tz = self.timezone.trim().parse().ok()?;
        let bounded = |text: &str, min, max| {
            text.trim()
                .parse::<u32>()
                .ok()
                .filter(|n| (min..=max).contains(n))
        };
        let reminder = |text: &str| {
            if text.trim().is_empty() {
                Some(None)
            } else {
                bounded(text, 5, 20_160).map(Some)
            }
        };
        if name.is_empty() || name.encode_utf16().count() > 120 {
            return None;
        }
        Some(SalonConfiguration {
            name: name.into(),
            timezone: timezone.name().to_owned(),
            slot_granularity_minutes: self.slot_step,
            min_notice_minutes: bounded(self.notice, 0, 43_200)?,
            max_days_ahead: bounded(self.horizon, 1, 365)?,
            online_booking_enabled: self.online_booking,
            reminder_first_lead_minutes: reminder(self.first_reminder)?,
            reminder_second_lead_minutes: reminder(self.second_reminder)?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SalonConfigurationWrite {
    expected_revision: DateTime<Utc>,
    changes: Map<String, Value>,
}

impl SalonConfigurationWrite {
    pub fn new(expected: &ReviewedSalonConfiguration, draft: &SalonConfiguration) -> Option<Self> {
        let original = serde_json::to_value(&expected.settings).ok()?;
        let draft = serde_json::to_value(draft).ok()?;
        let changes: Map<_, _> = draft
            .as_object()?
            .iter()
            .filter(|(key, value)| original.get(*key) != Some(*value))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        (!changes.is_empty()).then(|| Self {
            expected_revision: expected.revision,
            changes,
        })
    }

    pub fn review_against(&self, current: &SalonConfiguration) -> Option<SalonConfiguration> {
        let mut reviewed = serde_json::to_value(current).ok()?;
        reviewed.as_object_mut()?.extend(self.changes.clone());
        serde_json::from_value(reviewed).ok()
    }

    pub fn proposed_fields(&self) -> impl Iterator<Item = (&str, &Value)> {
        self.changes
            .iter()
            .map(|(name, value)| (name.as_str(), value))
    }
}

impl HttpTransport {
    pub fn salon_configuration(&self) -> Result<ReviewedSalonConfiguration, TransportError> {
        read_response(self.get(&self.agent, PATH, None)?, false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sends_only_changed_fields_and_null_for_a_disabled_reminder() {
        let saved = SalonConfiguration {
            name: "Studio".into(),
            timezone: "Europe/Madrid".into(),
            slot_granularity_minutes: 15,
            min_notice_minutes: 30,
            max_days_ahead: 60,
            online_booking_enabled: true,
            reminder_first_lead_minutes: Some(1440),
            reminder_second_lead_minutes: None,
        };

        let draft = SalonConfiguration {
            online_booking_enabled: false,
            reminder_first_lead_minutes: None,
            ..saved.clone()
        };
        let reviewed = ReviewedSalonConfiguration {
            settings: saved,
            revision: "2026-11-21T00:00:00Z".parse().unwrap(),
            generation: "initial".into(),
        };
        assert!(SalonConfigurationWrite::new(&reviewed, &reviewed.settings).is_none());
        let write = SalonConfigurationWrite::new(&reviewed, &draft).unwrap();
        assert_eq!(
            serde_json::to_value(write).unwrap(),
            serde_json::json!({
                "expectedRevision": "2026-11-21T00:00:00Z",
                "changes": { "onlineBookingEnabled": false, "reminderFirstLeadMinutes": null }
            })
        );
    }
}
