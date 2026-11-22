use std::collections::BTreeMap;

use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::{DateShiftRange, HttpTransport, TransportError, read_response};

const PATH: &str = "/admin/settings/desktop";
pub const SALON_SLOT_STEPS: [u32; 6] = [5, 10, 15, 20, 30, 60];
pub const OPENING_EXCEPTION_LIMIT: usize = 366;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpeningSchedule {
    pub weekly: Option<[Vec<DateShiftRange>; 7]>,
    pub exceptions: Vec<OpeningException>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpeningException {
    pub date: NaiveDate,
    pub ranges: Vec<DateShiftRange>,
}

#[derive(Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpeningScheduleEdits {
    #[serde(skip_serializing_if = "Option::is_none")]
    weekly_enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    days: BTreeMap<usize, Vec<DateShiftRange>>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    exceptions: BTreeMap<NaiveDate, Option<Vec<DateShiftRange>>>,
}

impl OpeningSchedule {
    fn changes_from(&self, base: &Self) -> OpeningScheduleEdits {
        let mut edits = OpeningScheduleEdits {
            weekly_enabled: (self.weekly.is_some() != base.weekly.is_some())
                .then_some(self.weekly.is_some()),
            ..OpeningScheduleEdits::default()
        };
        if let Some(week) = &self.weekly {
            for (day, ranges) in week.iter().enumerate() {
                let previous = base.weekly.as_ref().map_or(&[][..], |week| &week[day]);
                if ranges != previous {
                    edits.days.insert(day, ranges.clone());
                }
            }
        }
        let mut previous: BTreeMap<_, _> = base
            .exceptions
            .iter()
            .map(|entry| (entry.date, &entry.ranges))
            .collect();
        for entry in &self.exceptions {
            if previous.remove(&entry.date) != Some(&entry.ranges) {
                edits
                    .exceptions
                    .insert(entry.date, Some(entry.ranges.clone()));
            }
        }
        edits
            .exceptions
            .extend(previous.into_keys().map(|date| (date, None)));
        edits
    }

    fn apply_edits(&mut self, edits: OpeningScheduleEdits) -> Option<()> {
        if edits.weekly_enabled == Some(false) {
            self.weekly = None;
        } else if edits.weekly_enabled == Some(true) || !edits.days.is_empty() {
            let week = self.weekly.get_or_insert_with(Default::default);
            for (day, ranges) in edits.days {
                *week.get_mut(day)? = ranges;
            }
        }
        let mut exceptions: BTreeMap<_, _> = std::mem::take(&mut self.exceptions)
            .into_iter()
            .map(|entry| (entry.date, entry.ranges))
            .collect();
        for (date, ranges) in edits.exceptions {
            if let Some(ranges) = ranges {
                exceptions.insert(date, ranges);
            } else {
                exceptions.remove(&date);
            }
        }
        self.exceptions = exceptions
            .into_iter()
            .map(|(date, ranges)| OpeningException { date, ranges })
            .collect();
        Some(())
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BusinessProfile {
    pub description: Option<String>,
    pub category: Option<String>,
    pub address: Option<String>,
    pub phone: Option<String>,
    pub email: Option<String>,
    pub website: Option<String>,
    pub shop: Option<String>,
    pub instagram: Option<String>,
    pub rules: Option<String>,
    pub mobile_service: bool,
    pub published: bool,
    pub amenities: Vec<BusinessAmenity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opening_schedule: Option<OpeningSchedule>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BusinessAmenity {
    Wifi,
    Parking,
    AccessibleEntrance,
    CardPayments,
    ChildrenWelcome,
    PetsWelcome,
}

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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub business_profile: Option<BusinessProfile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(from = "ReviewedSalonConfigurationWire")]
pub struct ReviewedSalonConfiguration {
    #[serde(flatten)]
    pub settings: SalonConfiguration,
    pub revision: DateTime<Utc>,
    pub generation: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewedSalonConfigurationWire {
    #[serde(flatten)]
    settings: SalonConfiguration,
    revision: DateTime<Utc>,
    generation: String,
    opening_schedule: Option<OpeningSchedule>,
}

impl From<ReviewedSalonConfigurationWire> for ReviewedSalonConfiguration {
    fn from(wire: ReviewedSalonConfigurationWire) -> Self {
        let mut settings = wire.settings;
        if let Some(profile) = &mut settings.business_profile
            && let Some(schedule) = wire.opening_schedule
        {
            profile.opening_schedule = Some(schedule);
        }
        Self {
            settings,
            revision: wire.revision,
            generation: wire.generation,
        }
    }
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
            business_profile: None,
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
        let draft_json = serde_json::to_value(draft).ok()?;
        let mut changes: Map<_, _> = draft_json
            .as_object()?
            .iter()
            .filter(|(key, value)| original.get(*key) != Some(*value))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        if let Some(profile) = changes
            .get_mut("businessProfile")
            .and_then(Value::as_object_mut)
        {
            if let Some(original) = original.get("businessProfile").and_then(Value::as_object) {
                profile.retain(|field, value| original.get(field) != Some(value));
            }
            if profile.remove("openingSchedule").is_some() {
                let base = expected
                    .settings
                    .business_profile
                    .as_ref()
                    .and_then(|profile| profile.opening_schedule.as_ref());
                let next = draft.business_profile.as_ref()?.opening_schedule.as_ref()?;
                let edits = next.changes_from(base.unwrap_or(&OpeningSchedule::default()));
                if edits != OpeningScheduleEdits::default() {
                    profile.insert(
                        "openingScheduleEdits".into(),
                        serde_json::to_value(edits).ok()?,
                    );
                }
            }
            if profile.is_empty() {
                changes.remove("businessProfile");
            }
        }
        (!changes.is_empty()).then_some(Self {
            expected_revision: expected.revision,
            changes,
        })
    }

    pub fn review_against(&self, current: &SalonConfiguration) -> Option<SalonConfiguration> {
        let mut reviewed = serde_json::to_value(current).ok()?;
        let fields = reviewed.as_object_mut()?;
        for (key, value) in &self.changes {
            if key == "businessProfile"
                && let Some(original) = fields.get_mut(key).and_then(Value::as_object_mut)
                && let Some(changes) = value.as_object()
            {
                let mut changes = changes.clone();
                if let Some(edits) = changes.remove("openingScheduleEdits") {
                    let mut schedule: OpeningSchedule = original
                        .get("openingSchedule")
                        .map(|value| serde_json::from_value(value.clone()))
                        .transpose()
                        .ok()?
                        .unwrap_or_default();
                    schedule.apply_edits(serde_json::from_value(edits).ok()?)?;
                    original.insert(
                        "openingSchedule".into(),
                        serde_json::to_value(schedule).ok()?,
                    );
                }
                original.extend(changes);
            } else {
                fields.insert(key.clone(), value.clone());
            }
        }
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
    fn an_offline_profile_edit_rebases_only_its_changed_fields() {
        let base: ReviewedSalonConfiguration = serde_json::from_value(serde_json::json!({
            "name": "Studio", "timezone": "Europe/Madrid", "slotGranularityMinutes": 15,
            "minNoticeMinutes": 30, "maxDaysAhead": 60, "onlineBookingEnabled": true,
            "reminderFirstLeadMinutes": null, "reminderSecondLeadMinutes": null,
            "revision": "2026-11-21T00:00:00Z", "generation": "initial",
        }))
        .unwrap();
        assert!(base.settings.business_profile.is_none());
        let mut base = base;
        base.settings.business_profile = Some(BusinessProfile {
            address: Some("Old address".into()),
            ..BusinessProfile::default()
        });
        let mut draft = base.settings.clone();
        draft.business_profile.as_mut().unwrap().address = None;
        draft.business_profile.as_mut().unwrap().published = true;
        let write = SalonConfigurationWrite::new(&base, &draft).unwrap();
        assert_eq!(
            serde_json::to_value(&write).unwrap()["changes"],
            serde_json::json!({
                "businessProfile": { "address": null, "published": true }
            })
        );
        let mut remote = base.settings.clone();
        remote.business_profile.as_mut().unwrap().phone = Some("+34 555 010 123".into());
        let reviewed = write.review_against(&remote).unwrap();
        let profile = reviewed.business_profile.unwrap();
        assert!(profile.published);
        assert_eq!(profile.address, None);
        assert_eq!(profile.phone.as_deref(), Some("+34 555 010 123"));
    }

    #[test]
    fn opening_hours_review_retains_remote_weekdays_and_closures() {
        let base: ReviewedSalonConfiguration = serde_json::from_value(serde_json::json!({
            "name": "Studio", "timezone": "Europe/Madrid", "slotGranularityMinutes": 15,
            "minNoticeMinutes": 30, "maxDaysAhead": 60, "onlineBookingEnabled": true,
            "reminderFirstLeadMinutes": null, "reminderSecondLeadMinutes": null,
            "revision": "2026-11-21T00:00:00Z", "generation": "initial",
            "businessProfile": BusinessProfile::default(),
            "openingSchedule": {
                "weekly": [[], [], [], [], [], [], []],
                "exceptions": [{"date": "2026-12-24", "ranges": []}],
            },
        }))
        .unwrap();
        let morning = DateShiftRange {
            start_time: "09:00".into(),
            end_time: "12:00".into(),
        };
        let mut draft = base.settings.clone();
        let schedule = draft
            .business_profile
            .as_mut()
            .unwrap()
            .opening_schedule
            .as_mut()
            .unwrap();
        schedule.weekly.as_mut().unwrap()[1] = vec![morning.clone()];
        schedule.exceptions.clear();
        let write = SalonConfigurationWrite::new(&base, &draft).unwrap();
        let mut remote = base.settings.clone();
        let schedule = remote
            .business_profile
            .as_mut()
            .unwrap()
            .opening_schedule
            .as_mut()
            .unwrap();
        schedule.weekly.as_mut().unwrap()[2] = vec![morning.clone()];
        let closure = OpeningException {
            date: "2026-12-25".parse().unwrap(),
            ranges: vec![],
        };
        schedule.exceptions.push(closure.clone());
        let reviewed = write
            .review_against(&remote)
            .unwrap()
            .business_profile
            .unwrap()
            .opening_schedule
            .unwrap();
        assert_eq!(reviewed.exceptions, vec![closure]);
        let weekly = reviewed.weekly.unwrap();
        assert_eq!(weekly[1], vec![morning.clone()]);
        assert_eq!(weekly[2], vec![morning]);
    }

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
            business_profile: None,
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
