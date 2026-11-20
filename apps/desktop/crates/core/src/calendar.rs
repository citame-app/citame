//! Local calendar read model: server mirror plus the user's pending edits (the outbox).

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Duration, NaiveDate, TimeZone, Utc};
use chrono_tz::{GapInfo, Tz};
use serde_json::Value;

use crate::error::Result;
use crate::model::*;
use crate::store::Store;

pub(crate) fn service_work_windows(services: &[AppointmentService]) -> Vec<WorkWindow> {
    let mut offset = 0;
    let mut intervals = Vec::new();
    for service in services {
        let duration = service.duration_minutes;
        let next = offset + duration + service.buffer_minutes;
        if let Some(gap) = &service.processing
            && gap.starts_after_minutes > 0
            && gap.minutes > 0
            && gap.starts_after_minutes + gap.minutes < duration
        {
            let gap_start = offset + gap.starts_after_minutes;
            intervals.push(WorkWindow {
                offset_minutes: offset,
                end_offset_minutes: gap_start,
            });
            offset = gap_start + gap.minutes;
        }
        if offset < next {
            intervals.push(WorkWindow {
                offset_minutes: offset,
                end_offset_minutes: next,
            });
        }
        offset = next;
    }
    intervals
}

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
    pub blocks: Vec<CalendarBlock>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CalendarBlock {
    pub time_off: TimeOff,
    pub pending: bool,
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
    let midnight = date.and_hms_opt(0, 0, 0).expect("valid time");
    tz.from_local_datetime(&midnight)
        .earliest()
        .or_else(|| GapInfo::new(&midnight, &tz).and_then(|gap| gap.end))
        .map_or_else(|| midnight.and_utc(), |instant| instant.with_timezone(&Utc))
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
                        source_unpriced: false,
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
                        visit_group_id: None,
                        staff_id,
                        client_id: str_of(p, "clientId").unwrap_or_default(),
                        client_name: None,
                        starts_at,
                        ends_at: starts_at + Duration::minutes(block),
                        status: AppointmentStatus::Booked,
                        work_windows: Some(service_work_windows(&picked)),
                        notes: str_of(p, "notes"),
                        version: 1,
                        services: picked,
                        service_badges: Vec::new(),
                        billing_review_reasons: Vec::new(),
                        externally_settled: false,
                        external_balance: None,
                        imported_from_booksy: false,
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

/// The directory uses the same replica as booking and displays unsynced contact edits.
pub fn directory_clients(store: &Store) -> Result<Vec<Client>> {
    if !store.client_directory_enabled()? {
        return Ok(vec![]);
    }
    let mut clients: HashMap<_, _> = store
        .clients()?
        .into_iter()
        .filter(|client| client.merged_into_id.is_none())
        .map(|client| (client.id.clone(), client))
        .collect();
    for entry in store.outbox(usize::MAX)? {
        let payload = &entry.payload;
        match entry.kind.as_str() {
            "client.create" => {
                if let (Some(name), Some(at)) = (
                    str_of(payload, "name"),
                    DateTime::parse_from_rfc3339(&entry.created_at).ok(),
                ) {
                    clients.entry(entry.entity_id.clone()).or_insert(Client {
                        id: entry.entity_id,
                        merged_into_id: None,
                        name,
                        phone: str_of(payload, "phone"),
                        email: str_of(payload, "email"),
                        notes: str_of(payload, "notes"),
                        created_at: at.with_timezone(&Utc),
                        updated_at: at.with_timezone(&Utc),
                    });
                }
            }
            "client.update" => {
                if let Some(client) = clients.get_mut(&entry.entity_id) {
                    if let Some(name) = str_of(payload, "name") {
                        client.name = name;
                    }
                    if payload.get("phone").is_some() {
                        client.phone = str_of(payload, "phone");
                    }
                    if payload.get("notes").is_some() {
                        client.notes = str_of(payload, "notes");
                    }
                }
            }
            _ => {}
        }
    }
    let mut clients: Vec<_> = clients.into_values().collect();
    clients.sort_by_cached_key(|client| (client.name.to_lowercase(), client.id.clone()));
    Ok(clients)
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

pub(crate) fn effective_appointments_between(
    store: &Store,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> Result<Vec<Appointment>> {
    let mut map = store
        .appointments_between(from.timestamp_millis(), to.timestamp_millis())?
        .into_iter()
        .map(|a| (a.id.clone(), a))
        .collect();
    overlay(store, &mut map, &mut HashMap::new())?;
    Ok(map
        .into_values()
        .filter(|a| {
            a.status != AppointmentStatus::Cancelled && a.starts_at < to && a.ends_at > from
        })
        .collect())
}

/// Pending edits remain local until their result is acknowledged. Rejected edits are shown
/// in the conflict inbox and the mirror remains the authoritative fallback.
pub fn effective_time_off(
    store: &Store,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> Result<Vec<CalendarBlock>> {
    let mut blocks: HashMap<_, _> = store
        .time_off_between(from.timestamp_millis(), to.timestamp_millis())?
        .into_iter()
        .map(|row| {
            (
                row.id.clone(),
                CalendarBlock {
                    time_off: row,
                    pending: false,
                },
            )
        })
        .collect();
    for entry in store.outbox(usize::MAX)? {
        let p = &entry.payload;
        match entry.kind.as_str() {
            "time_off.create" | "time_off.update" => {
                if let (Some(staff_id), Some(starts_at), Some(ends_at), Ok(updated_at)) = (
                    str_of(p, "staffId"),
                    p.get("startsAt").and_then(parse_instant),
                    p.get("endsAt").and_then(parse_instant),
                    entry.created_at.parse::<DateTime<Utc>>(),
                ) {
                    blocks.insert(
                        entry.entity_id.clone(),
                        CalendarBlock {
                            time_off: TimeOff {
                                id: entry.entity_id,
                                staff_id,
                                starts_at,
                                ends_at,
                                reason: str_of(p, "reason"),
                                updated_at,
                            },
                            pending: true,
                        },
                    );
                }
            }
            "time_off.delete" => {
                blocks.remove(&entry.entity_id);
            }
            _ => {}
        }
    }
    let mut rows: Vec<_> = blocks
        .into_values()
        .filter(|b| b.time_off.starts_at < to && b.time_off.ends_at > from)
        .collect();
    rows.sort_by(|a, b| {
        a.time_off
            .starts_at
            .cmp(&b.time_off.starts_at)
            .then(a.time_off.id.cmp(&b.time_off.id))
    });
    Ok(rows)
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
            blocks: vec![],
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
                    .or_else(|| a.client_name.clone())
                    .unwrap_or_else(|| "Unknown client".into()),
                pending: pending.contains(&a.id),
                conflict: conflicts.contains(&a.id),
                appointment: a,
            });
        }
    }
    for block in effective_time_off(store, from, to)? {
        if let Some(col) = columns
            .iter_mut()
            .find(|c| c.staff.id == block.time_off.staff_id)
        {
            col.blocks.push(block);
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
