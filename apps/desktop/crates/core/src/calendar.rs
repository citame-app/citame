//! Local calendar read model: server mirror plus the user's pending edits (the outbox).

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Duration, NaiveDate, TimeZone, Utc};
use chrono_tz::Tz;
use serde_json::Value;

use crate::error::Result;
use crate::model::*;
use crate::store::Store;

#[derive(Debug, Clone, PartialEq)]
pub struct CalendarItem {
    pub appointment: Appointment,
    pub client_name: String,
    /// True while a local edit for this appointment has not been acknowledged by the server.
    pub pending: bool,
    /// True when a rejected edit of this appointment awaits the user's decision.
    pub conflict: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct StaffColumn {
    pub staff: Staff,
    pub items: Vec<CalendarItem>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DayView {
    pub date: NaiveDate,
    pub timezone: String,
    pub columns: Vec<StaffColumn>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SyncSummary {
    pub pending: usize,
    pub conflicts: usize,
    pub cursor: i64,
}

/// The salon's timezone (UTC until the first pull brings the settings).
pub fn salon_tz(store: &Store) -> Result<Tz> {
    Ok(store
        .salon_settings()?
        .and_then(|s| s.timezone.parse::<Tz>().ok())
        .unwrap_or(Tz::UTC))
}

fn local_midnight(tz: Tz, date: NaiveDate) -> DateTime<Utc> {
    // A DST gap at midnight exists in a few zones; fall back to the first valid instant.
    for hour in 0..4 {
        let naive = date.and_hms_opt(hour, 0, 0).expect("valid time");
        if let Some(dt) = tz.from_local_datetime(&naive).earliest() {
            return dt.with_timezone(&Utc);
        }
    }
    Utc.from_utc_datetime(&date.and_hms_opt(0, 0, 0).expect("valid time"))
}

/// `[start, end)` of a local calendar day in UTC.
pub fn local_day_range(tz: Tz, date: NaiveDate) -> (DateTime<Utc>, DateTime<Utc>) {
    let next = date.succ_opt().unwrap_or(date);
    (local_midnight(tz, date), local_midnight(tz, next))
}

fn parse_instant(v: &Value) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(v.as_str()?)
        .ok()
        .map(|d| d.with_timezone(&Utc))
}

fn str_of(v: &Value, key: &str) -> Option<String> {
    v.get(key)?.as_str().map(str::to_owned)
}

/// Applies the outbox, in order, on top of `map` (mirror state). Returns the ids of the
/// appointments that carry unacknowledged edits.
fn overlay(
    store: &Store,
    map: &mut HashMap<String, Appointment>,
    client_names: &mut HashMap<String, String>,
) -> Result<HashSet<String>> {
    let outbox = store.outbox(usize::MAX)?;
    let mut pending = HashSet::new();
    if outbox.is_empty() {
        return Ok(pending);
    }
    let services: HashMap<String, Service> = store
        .services()?
        .into_iter()
        .map(|s| (s.id.clone(), s))
        .collect();
    for e in &outbox {
        if e.kind.starts_with("appointment.")
            && !map.contains_key(&e.entity_id)
            && let Some(a) = store.appointment(&e.entity_id)?
        {
            map.insert(a.id.clone(), a);
        }
    }
    for e in &outbox {
        let p = &e.payload;
        let stamp = DateTime::parse_from_rfc3339(&e.created_at)
            .map(|d| d.with_timezone(&Utc))
            .unwrap_or_else(|_| Utc::now());
        match e.kind.as_str() {
            "appointment.create" => {
                let (Some(staff_id), Some(starts_at)) = (
                    str_of(p, "staffId"),
                    p.get("startsAt").and_then(parse_instant),
                ) else {
                    continue;
                };
                let catalog_picked: Vec<AppointmentService> = p
                    .get("serviceIds")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|id| services.get(id.as_str()?))
                    .map(|s| AppointmentService {
                        service_id: Some(s.id.clone()),
                        name: s.name.clone(),
                        duration_minutes: s.duration_minutes,
                        buffer_minutes: s.buffer_minutes,
                        price_cents: s.price_cents,
                        currency: s.currency.clone(),
                        processing: s.processing.clone(),
                    })
                    .collect();
                let picked: Vec<AppointmentService> = p
                    .get("_reviewedServices")
                    .and_then(|value| serde_json::from_value(value.clone()).ok())
                    .unwrap_or(catalog_picked);
                let block: i64 = picked
                    .iter()
                    .map(|s| s.duration_minutes + s.buffer_minutes)
                    .sum();
                map.insert(
                    e.entity_id.clone(),
                    Appointment {
                        id: e.entity_id.clone(),
                        staff_id,
                        client_id: str_of(p, "clientId").unwrap_or_default(),
                        starts_at,
                        ends_at: starts_at + Duration::minutes(block),
                        status: AppointmentStatus::Booked,
                        notes: str_of(p, "notes"),
                        version: 1,
                        services: picked,
                        created_at: stamp,
                        updated_at: stamp,
                    },
                );
                pending.insert(e.entity_id.clone());
            }
            "appointment.reschedule" => {
                if let Some(a) = map.get_mut(&e.entity_id) {
                    if let Some(start) = p.get("startsAt").and_then(parse_instant) {
                        let len = a.ends_at - a.starts_at;
                        a.starts_at = start;
                        a.ends_at = start + len;
                    }
                    if let Some(staff) = str_of(p, "staffId") {
                        a.staff_id = staff;
                    }
                    if let Some(n) = str_of(p, "notes") {
                        a.notes = Some(n);
                    }
                    a.version += 1;
                    a.updated_at = stamp;
                    pending.insert(e.entity_id.clone());
                }
            }
            "appointment.cancel" | "appointment.set_status" => {
                if let Some(a) = map.get_mut(&e.entity_id) {
                    a.status = match (e.kind.as_str(), str_of(p, "status").as_deref()) {
                        ("appointment.set_status", Some(s)) => {
                            AppointmentStatus::parse(s).unwrap_or(a.status)
                        }
                        _ => AppointmentStatus::Cancelled,
                    };
                    a.version += 1;
                    a.updated_at = stamp;
                    pending.insert(e.entity_id.clone());
                }
            }
            "client.create" => {
                if let Some(name) = str_of(p, "name") {
                    client_names.insert(e.entity_id.clone(), name);
                }
            }
            "client.update" => {
                if let (Some(name), Some(slot)) =
                    (str_of(p, "name"), client_names.get_mut(&e.entity_id))
                {
                    *slot = name;
                }
            }
            _ => {}
        }
    }
    Ok(pending)
}

fn client_names(store: &Store) -> Result<HashMap<String, String>> {
    Ok(store
        .clients()?
        .into_iter()
        .map(|c| (c.id, c.name))
        .collect())
}

/// Ids and display names of every client the user can book right now (mirror plus queued).
pub fn known_clients(store: &Store) -> Result<Vec<(String, String)>> {
    let mut names = client_names(store)?;
    overlay(store, &mut HashMap::new(), &mut names)?;
    for alias in store
        .clients()?
        .into_iter()
        .filter(|c| c.merged_into_id.is_some())
    {
        names.remove(&alias.id);
    }
    let mut v: Vec<_> = names.into_iter().collect();
    v.sort_by(|a, b| {
        a.1.to_lowercase()
            .cmp(&b.1.to_lowercase())
            .then(a.0.cmp(&b.0))
    });
    Ok(v)
}

/// An appointment as the user should see it now: mirror state with pending edits applied.
pub fn effective_appointment(store: &Store, id: &str) -> Result<Option<Appointment>> {
    let mut map = HashMap::new();
    if let Some(a) = store.appointment(id)? {
        map.insert(a.id.clone(), a);
    }
    overlay(store, &mut map, &mut HashMap::new())?;
    Ok(map.remove(id))
}

pub fn day_view(store: &Store, date: NaiveDate) -> Result<DayView> {
    let tz = salon_tz(store)?;
    let (from, to) = local_day_range(tz, date);
    let mut map: HashMap<String, Appointment> = store
        .appointments_between(from.timestamp_millis(), to.timestamp_millis())?
        .into_iter()
        .map(|a| (a.id.clone(), a))
        .collect();
    let mut names = client_names(store)?;
    let pending = overlay(store, &mut map, &mut names)?;
    let conflicts: HashSet<String> = store
        .conflicts()?
        .into_iter()
        .map(|c| c.entity_id)
        .collect();

    let mut columns: Vec<StaffColumn> = store
        .staff()?
        .into_iter()
        .map(|staff| StaffColumn {
            staff,
            items: vec![],
        })
        .collect();
    let mut appts: Vec<Appointment> = map
        .into_values()
        .filter(|a| {
            a.status != AppointmentStatus::Cancelled && a.starts_at < to && a.ends_at > from
        })
        .collect();
    appts.sort_by(|a, b| a.starts_at.cmp(&b.starts_at).then(a.id.cmp(&b.id)));
    for a in appts {
        if let Some(col) = columns.iter_mut().find(|c| c.staff.id == a.staff_id) {
            col.items.push(CalendarItem {
                client_name: names
                    .get(&a.client_id)
                    .cloned()
                    .unwrap_or_else(|| "Unknown client".into()),
                pending: pending.contains(&a.id),
                conflict: conflicts.contains(&a.id),
                appointment: a,
            });
        }
    }
    Ok(DayView {
        date,
        timezone: tz.name().to_owned(),
        columns,
    })
}

/// Seven consecutive days starting at `first_day`.
pub fn week_view(store: &Store, first_day: NaiveDate) -> Result<Vec<DayView>> {
    (0..7)
        .map(|i| day_view(store, first_day + Duration::days(i)))
        .collect()
}

pub fn sync_summary(store: &Store) -> Result<SyncSummary> {
    Ok(SyncSummary {
        pending: store.outbox_len()?,
        conflicts: store.conflicts()?.len(),
        cursor: store.cursor()?,
    })
}
