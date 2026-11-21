use std::collections::HashMap;

use chrono::{DateTime, Datelike, Days, NaiveDate, Utc};
use chrono_tz::Tz;

use crate::calendar::{effective_time_off, local_day_range, salon_tz};
use crate::error::{CoreError, Result};
use crate::model::DateShiftRange;
use crate::store::Store;

#[derive(Debug)]
pub struct TeamWeek {
    pub week: NaiveDate,
    pub timezone: Tz,
    pub days: Vec<NaiveDate>,
    pub members: Vec<StaffWeek>,
}

#[derive(Debug)]
pub struct StaffWeek {
    pub id: String,
    pub name: String,
    pub days: Vec<ShiftDay>,
}

#[derive(Debug)]
pub struct ShiftDay {
    pub ranges: Vec<DateShiftRange>,
    pub custom: bool,
    pub absences: Vec<Absence>,
}

#[derive(Debug)]
pub struct Absence {
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
    pub full_day: bool,
    pub pending: bool,
}

pub(crate) struct ScheduleRanges {
    weekly: HashMap<(String, i64), Vec<DateShiftRange>>,
    dated: HashMap<(String, String), Vec<DateShiftRange>>,
}

impl ScheduleRanges {
    pub(crate) fn load(store: &Store, first: NaiveDate, end: NaiveDate) -> Result<Self> {
        let mut weekly = HashMap::<_, Vec<_>>::new();
        for row in store.working_hours()? {
            weekly
                .entry((row.staff_id, row.weekday))
                .or_default()
                .push(DateShiftRange {
                    start_time: row.start_time,
                    end_time: row.end_time,
                });
        }
        for ranges in weekly.values_mut() {
            ranges.sort_by(|a, b| {
                a.start_time
                    .cmp(&b.start_time)
                    .then(a.end_time.cmp(&b.end_time))
            });
        }
        let dated = store
            .date_shifts_between(&first.to_string(), &end.to_string())?
            .into_iter()
            .filter_map(|row| row.ranges.map(|ranges| ((row.staff_id, row.date), ranges)))
            .collect();
        Ok(Self { weekly, dated })
    }

    pub(crate) fn for_day(&self, staff_id: &str, day: NaiveDate) -> (bool, &[DateShiftRange]) {
        if let Some(dated) = self.dated.get(&(staff_id.to_owned(), day.to_string())) {
            (true, dated)
        } else {
            let day = i64::from(day.weekday().num_days_from_sunday());
            (
                false,
                self.weekly
                    .get(&(staff_id.to_owned(), day))
                    .map_or(&[], Vec::as_slice),
            )
        }
    }
}

pub fn week_start(date: NaiveDate) -> Option<NaiveDate> {
    let week = date.checked_sub_days(Days::new(date.weekday().num_days_from_monday().into()))?;
    let until = week.checked_add_days(Days::new(7))?;
    (week.year() > 0 && until.year() <= 9999).then_some(week)
}

/// Uses the replica's latest permission state and overlays pending local blocks.
pub fn team_week(store: &Store, date: NaiveDate) -> Result<TeamWeek> {
    let invalid_week = || CoreError::Invalid("A complete week is required".into());
    let week = week_start(date).ok_or_else(invalid_week)?;
    let next_week = week
        .checked_add_days(Days::new(7))
        .ok_or_else(invalid_week)?;
    let days: Vec<_> = week.iter_days().take(7).collect();

    store.read_snapshot(|store| {
        let timezone = salon_tz(store)?;
        let calendar_scope = store.get_meta("calendar_scope")?;
        let time_off_scope = store.get_meta("time_off_scope")?;
        let all =
            calendar_scope.as_deref() == Some("all") && time_off_scope.as_deref() == Some("all");
        let own = match calendar_scope.as_deref() {
            Some("all") => time_off_scope.as_deref().filter(|scope| *scope != "none"),
            Some("none") | None => None,
            staff_id => staff_id,
        };
        let schedule = ScheduleRanges::load(store, week, next_week)?;
        let boundaries: Vec<_> = days
            .iter()
            .map(|day| local_day_range(timezone, *day))
            .collect();
        let (from, _) = local_day_range(timezone, week);
        let (until, _) = local_day_range(timezone, next_week);
        let mut blocks = HashMap::<_, Vec<_>>::new();
        for block in effective_time_off(store, from, until)? {
            blocks
                .entry(block.time_off.staff_id.clone())
                .or_default()
                .push(block);
        }
        let members = store
            .staff()?
            .into_iter()
            .filter(|staff| all || own == Some(staff.id.as_str()))
            .map(|staff| {
                let staff_blocks = blocks.remove(&staff.id).unwrap_or_default();
                let days = days
                    .iter()
                    .zip(&boundaries)
                    .map(|(day, &(start, end))| {
                        let (custom, ranges) = schedule.for_day(&staff.id, *day);
                        let absences = staff_blocks
                            .iter()
                            .filter_map(|block| {
                                let (clipped_start, clipped_end) =
                                    block.interval_within(start, end)?;
                                Some(Absence {
                                    start: clipped_start,
                                    end: clipped_end,
                                    full_day: clipped_start == start && clipped_end == end,
                                    pending: block.pending,
                                })
                            })
                            .collect();
                        ShiftDay {
                            ranges: ranges.to_vec(),
                            custom,
                            absences,
                        }
                    })
                    .collect();
                StaffWeek {
                    id: staff.id,
                    name: staff.display_name,
                    days,
                }
            })
            .collect();
        Ok(TeamWeek {
            week,
            timezone,
            days,
            members,
        })
    })
}
