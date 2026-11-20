use super::*;
use chrono::{DateTime, Datelike, Days as CalendarDays, NaiveDate, NaiveTime, TimeZone, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatedShiftDay {
    pub date: NaiveDate,
    pub version: u32,
    pub ranges: Option<Vec<DateShiftRange>>,
    pub effective_ranges: Vec<DateShiftRange>,
}

#[derive(Clone, Debug, Serialize)]
pub struct DatedShiftEdit {
    pub date: NaiveDate,
    /// None restores the weekly template; an empty vector explicitly closes the day.
    pub ranges: Option<Vec<DateShiftRange>>,
}

impl DatedShiftEdit {
    pub fn parse_ranges<'a>(
        input: impl Iterator<Item = (&'a str, &'a str)>,
    ) -> Option<Vec<DateShiftRange>> {
        let ranges = parse_wall_ranges(input)?;
        (!ranges.is_empty() && ranges.len() <= 8).then_some(ranges)
    }

    pub fn has_nonexistent_time(&self, timezone: Tz) -> bool {
        self.ranges.iter().flatten().any(|range| {
            [&range.start_time, &range.end_time]
                .into_iter()
                .any(|value| {
                    NaiveTime::parse_from_str(value, "%H:%M").is_ok_and(|time| {
                        matches!(
                            timezone.from_local_datetime(&self.date.and_time(time)),
                            chrono::LocalResult::None
                        )
                    })
                })
        })
    }
}

pub(super) fn parse_wall_ranges<'a>(
    input: impl Iterator<Item = (&'a str, &'a str)>,
) -> Option<Vec<DateShiftRange>> {
    let parse = |value: &str| {
        let value = value.trim();
        let time = chrono::NaiveTime::parse_from_str(value, "%H:%M").ok()?;
        (time.format("%H:%M").to_string() == value).then(|| value.to_owned())
    };
    let mut ranges = input
        .map(|(start, end)| {
            Some(DateShiftRange {
                start_time: parse(start)?,
                end_time: parse(end)?,
            })
        })
        .collect::<Option<Vec<_>>>()?;
    ranges.sort_by(|a, b| a.start_time.cmp(&b.start_time));
    (ranges.iter().all(|r| r.start_time < r.end_time)
        && ranges
            .windows(2)
            .all(|pair| pair[0].end_time <= pair[1].start_time))
    .then_some(ranges)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatedShiftConflictReason {
    OutsideWorkingHours,
    TimeOff,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatedShiftConflict {
    pub appointment_id: Uuid,
    pub client_id: Uuid,
    pub starts_at: DateTime<Utc>,
    pub ends_at: DateTime<Utc>,
    pub reasons: Vec<DatedShiftConflictReason>,
}

#[derive(Debug)]
pub struct DatedShiftReview {
    pub timezone: Tz,
    pub changes: Vec<DatedShiftChange>,
    pub conflicts: Vec<DatedShiftConflict>,
    pub withdrawn_offers: u32,
}

#[derive(Debug)]
pub struct ReviewedDatedShift {
    pub review: DatedShiftReview,
    staff_id: Uuid,
    selection: DatedShiftSelection,
    hash: String,
    idempotency_key: uuid::Uuid,
}

#[derive(Debug, Deserialize)]
pub struct DatedShiftChange {
    pub date: NaiveDate,
    pub previous: DatedShiftDay,
    pub next: DatedShiftDay,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatedShiftCopy {
    source_from: NaiveDate,
    days: u8,
    target_starts: Vec<NaiveDate>,
}

impl DatedShiftCopy {
    pub fn new(source: NaiveDate, days: u8, target: NaiveDate, weeks: u8) -> Option<Self> {
        if !(1..=7).contains(&days) || !(1..=12).contains(&weeks) {
            return None;
        }
        let last_day = u64::from(days - 1);
        let source_end = shift_date(source, last_day)?;
        let target_starts = (0..u64::from(weeks))
            .map(|week| shift_date(target, 7 * week))
            .collect::<Option<Vec<_>>>()?;
        for &start in &target_starts {
            let end = shift_date(start, last_day)?;
            if start <= source_end && source <= end {
                return None;
            }
        }
        Some(Self {
            source_from: source,
            days,
            target_starts,
        })
    }

    fn dates(&self) -> impl Iterator<Item = NaiveDate> + '_ {
        self.target_starts
            .iter()
            .flat_map(|start| start.iter_days().take(usize::from(self.days)))
    }
}

fn shift_date(date: NaiveDate, days: u64) -> Option<NaiveDate> {
    let shifted = date.checked_add_days(CalendarDays::new(days))?;
    (date.year() >= 0 && shifted.year() <= 9999).then_some(shifted)
}

#[derive(Debug, Serialize)]
#[serde(tag = "mode", rename_all = "lowercase")]
pub enum DatedShiftSelection {
    Edit { changes: [DatedShiftEdit; 1] },
    Copy(DatedShiftCopy),
}

impl DatedShiftSelection {
    fn dates(&self) -> Vec<NaiveDate> {
        match self {
            Self::Edit { changes: [edit] } => vec![edit.date],
            Self::Copy(copy) => copy.dates().collect(),
        }
    }

    fn matches(&self, change: &DatedShiftChange) -> bool {
        change.previous.date == change.date
            && change.next.date == change.date
            && match self {
                Self::Edit { changes: [edit] } => change.next.ranges == edit.ranges,
                Self::Copy(_) => change.next.ranges.as_ref() == Some(&change.next.effective_ranges),
            }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Days {
    staff_id: Uuid,
    days: Vec<DatedShiftDay>,
}

impl Days {
    fn take_day(self, staff_id: Uuid, date: NaiveDate) -> Result<DatedShiftDay, TransportError> {
        let [day] = self.days.try_into().map_err(|_| invalid_response())?;
        if self.staff_id != staff_id || day.date != date {
            return Err(invalid_response());
        }
        Ok(day)
    }
}

fn invalid_response() -> TransportError {
    TransportError::Server("Unexpected dated shift response".into())
}

impl HttpTransport {
    pub fn dated_shift(
        &self,
        staff_id: &str,
        date: NaiveDate,
    ) -> Result<DatedShiftDay, TransportError> {
        let staff_id = parse_id(staff_id)?;
        let path = format!("/admin/staff/{staff_id}/date-shifts?from={date}&to={date}");
        let data: Days = read_response(self.get(&self.agent, &path, None)?, false)?;
        data.take_day(staff_id, date)
    }

    pub fn review_dated_shifts(
        &self,
        staff_id: &str,
        selection: DatedShiftSelection,
    ) -> Result<ReviewedDatedShift, TransportError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Preview {
            staff_id: Uuid,
            timezone: String,
            review_hash: String,
            changes: Vec<DatedShiftChange>,
            conflicts: Vec<DatedShiftConflict>,
            withdrawn_offers: u32,
        }
        let staff_id = parse_id(staff_id)?;
        let path = format!("/admin/staff/{staff_id}/date-shifts/preview");
        let data: Preview = self.post_json(&path, &selection)?;
        if data.staff_id != staff_id
            || data
                .changes
                .iter()
                .map(|change| change.date)
                .ne(selection.dates())
            || !data.changes.iter().all(|change| selection.matches(change))
            || data.review_hash.len() != 64
            || !data
                .review_hash
                .bytes()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        {
            return Err(invalid_response());
        }
        Ok(ReviewedDatedShift {
            review: DatedShiftReview {
                timezone: data.timezone.parse().map_err(|_| invalid_response())?,
                changes: data.changes,
                conflicts: data.conflicts,
                withdrawn_offers: data.withdrawn_offers,
            },
            staff_id,
            selection,
            hash: data.review_hash,
            idempotency_key: uuid::Uuid::now_v7(),
        })
    }

    /// A missing result means the server rejected the review as stale. Retrying a lost
    /// response sends the same reviewed selection and idempotency key.
    pub fn commit_dated_shifts(
        &self,
        reviewed: &ReviewedDatedShift,
    ) -> Result<Option<Vec<DatedShiftDay>>, TransportError> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Commit<'a> {
            selection: &'a DatedShiftSelection,
            review_hash: &'a str,
            idempotency_key: uuid::Uuid,
        }
        let path = format!("/admin/staff/{}/date-shifts", reviewed.staff_id);
        enum CommitFailure {
            Stale,
            Transport(TransportError),
        }
        impl From<TransportError> for CommitFailure {
            fn from(error: TransportError) -> Self {
                Self::Transport(error)
            }
        }
        let response = self.send_json(
            &path,
            &Commit {
                selection: &reviewed.selection,
                review_hash: &reviewed.hash,
                idempotency_key: reviewed.idempotency_key,
            },
        )?;
        let result = read_response_with(response, |status, retry_after, body| {
            let stale = status == 409
                && serde_json::from_str::<serde_json::Value>(body).is_ok_and(|value| {
                    value
                        .pointer("/error/code")
                        .and_then(serde_json::Value::as_str)
                        == Some("version_conflict")
                });
            if stale {
                CommitFailure::Stale
            } else {
                classify_status(status, retry_after, body, false).into()
            }
        });
        match result {
            Ok(Days { staff_id, days })
                if staff_id == reviewed.staff_id
                    && days
                        .iter()
                        .map(|day| day.date)
                        .eq(reviewed.selection.dates()) =>
            {
                Ok(Some(days))
            }
            Ok(_) => Err(invalid_response()),
            Err(CommitFailure::Stale) => Ok(None),
            Err(CommitFailure::Transport(error)) => Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn range_editor_sorts_and_rejects_ambiguous_or_overlapping_input() {
        let valid =
            DatedShiftEdit::parse_ranges([("14:00", "18:00"), ("09:00", "14:00")].into_iter())
                .unwrap();
        assert_eq!(valid[0].start_time, "09:00");
        for invalid in [
            [("9:00", "12:00"), ("13:00", "17:00")],
            [("09:00", "14:00"), ("13:00", "17:00")],
            [("12:00", "12:00"), ("13:00", "17:00")],
        ] {
            assert!(DatedShiftEdit::parse_ranges(invalid.into_iter()).is_none());
        }
    }

    #[test]
    fn copy_requires_disjoint_dates_and_bounds_repeats() {
        let source = NaiveDate::from_ymd_opt(2028, 2, 28).unwrap();
        let target = NaiveDate::from_ymd_opt(2028, 3, 1).unwrap();
        assert!(DatedShiftCopy::new(source, 3, target, 1).is_none());
        assert!(DatedShiftCopy::new(source, 2, target, 13).is_none());
        assert!(DatedShiftCopy::new(source, 0, target, 1).is_none());
        let copy = DatedShiftSelection::Copy(DatedShiftCopy::new(source, 2, target, 2).unwrap());
        assert_eq!(
            serde_json::to_value(copy).unwrap(),
            serde_json::json!({
                "mode": "copy", "sourceFrom": "2028-02-28", "days": 2,
                "targetStarts": ["2028-03-01", "2028-03-08"]
            })
        );
    }
}
