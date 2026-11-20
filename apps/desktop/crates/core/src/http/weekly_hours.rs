use super::{date_shifts::parse_wall_ranges, *};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WeeklyRange {
    pub weekday: u8,
    pub start_time: String,
    pub end_time: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WeeklyHours {
    staff_id: Uuid,
    revision: String,
    pub hours: Vec<WeeklyRange>,
    pub conflicts: Vec<date_shifts::DatedShiftConflict>,
}

pub fn parse_weekly_hours<'a>(days: [Vec<(&'a str, &'a str)>; 7]) -> Option<Vec<WeeklyRange>> {
    let mut hours = Vec::new();
    for (weekday, entries) in days.into_iter().enumerate() {
        hours.extend(
            parse_wall_ranges(entries.into_iter())?
                .into_iter()
                .map(|range| WeeklyRange {
                    weekday: weekday as u8,
                    start_time: range.start_time,
                    end_time: range.end_time,
                }),
        );
    }
    (hours.len() <= 56).then_some(hours)
}

fn check_hours(staff: Uuid, result: WeeklyHours) -> Result<WeeklyHours, TransportError> {
    if result.staff_id != staff
        || result.revision.len() != 64
        || !result
            .revision
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        || result.hours.iter().any(|range| range.weekday > 6)
    {
        return Err(TransportError::Server(
            "Unexpected weekly hours response".into(),
        ));
    }
    Ok(result)
}

#[derive(Debug)]
enum SaveError {
    Stale,
    Transport(TransportError),
}

impl From<TransportError> for SaveError {
    fn from(error: TransportError) -> Self {
        Self::Transport(error)
    }
}

impl HttpTransport {
    pub fn weekly_hours(&self, staff_id: &str) -> Result<WeeklyHours, TransportError> {
        let staff = parse_id(staff_id)?;
        let response = self.get(
            &self.agent,
            &format!("/admin/staff/{staff}/working-hours"),
            None,
        )?;
        check_hours(staff, read_response(response, false)?)
    }

    /// None means the revision changed. A retry of an already applied schedule is a no-op.
    pub fn save_weekly_hours(
        &self,
        baseline: &WeeklyHours,
        hours: &[WeeklyRange],
    ) -> Result<Option<WeeklyHours>, TransportError> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Command<'a> {
            expected_revision: &'a str,
            hours: &'a [WeeklyRange],
        }
        let staff = baseline.staff_id;
        let response = self.send_put_json(
            &format!("/admin/staff/{staff}/working-hours"),
            &Command {
                expected_revision: &baseline.revision,
                hours,
            },
        )?;
        match read_response_with(response, |status, retry_after, body| {
            if status == 409
                && serde_json::from_str::<serde_json::Value>(body).is_ok_and(|value| {
                    value
                        .pointer("/error/code")
                        .and_then(serde_json::Value::as_str)
                        == Some("version_conflict")
                })
            {
                SaveError::Stale
            } else {
                classify_status(status, retry_after, body, false).into()
            }
        }) {
            Ok(result) => {
                let result = check_hours(staff, result)?;
                if result.hours != hours {
                    return Err(TransportError::Server(
                        "Unexpected saved weekly hours".into(),
                    ));
                }
                Ok(Some(result))
            }
            Err(SaveError::Stale) => Ok(None),
            Err(SaveError::Transport(error)) => Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weekly_validation_preserves_closed_days_and_sorts_disjoint_wall_times() {
        let mut days = std::array::from_fn(|_| Vec::new());
        days[1] = vec![("14:00", "18:00"), ("09:00", "14:00")];
        let hours = parse_weekly_hours(days.clone()).unwrap();
        assert_eq!(
            hours.iter().map(|range| range.weekday).collect::<Vec<_>>(),
            [1, 1]
        );
        assert_eq!(hours[0].start_time, "09:00");
        days[1].push(("13:59", "14:00"));
        assert!(parse_weekly_hours(days).is_none());
        assert!(
            parse_weekly_hours(std::array::from_fn(|_| Vec::new()))
                .unwrap()
                .is_empty()
        );
    }
}
