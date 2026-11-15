//! User actions. Each one writes to the outbox first; the calendar shows it as pending at once.

use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{Map, Value, json};

use crate::calendar::{effective_appointment, known_clients};
use crate::error::{CoreError, Result};
use crate::model::AppointmentStatus;
use crate::store::Store;

/// Longest free text the API accepts (`LIMITS` in `packages/contracts`). Counted in UTF-16 code
/// units, the way the server's validation counts, so an emoji costs two.
const MAX_NAME: usize = 200;
const MAX_PHONE: usize = 32;
const MAX_NOTES: usize = 2000;

fn check_len(what: &str, value: &str, max: usize) -> Result<()> {
    if value.encode_utf16().count() > max {
        return Err(CoreError::Invalid(format!(
            "{what} is longer than {max} characters"
        )));
    }
    Ok(())
}

fn iso(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[derive(Debug, Clone)]
pub struct NewAppointment {
    pub staff_id: String,
    pub service_ids: Vec<String>,
    pub starts_at: DateTime<Utc>,
    pub client_id: String,
    pub notes: Option<String>,
    /// Staff and owners may book inside the minimum-notice window.
    pub override_notice: bool,
}

#[derive(Debug, Clone)]
pub enum Resolution {
    /// Pick another time (and optionally another staff member) and try again.
    Reschedule {
        starts_at: DateTime<Utc>,
        staff_id: Option<String>,
    },
    /// Give up: drops a pending booking, or cancels an existing appointment.
    Cancel,
    /// Acknowledge a rejection that needs no action (non-appointment edits).
    Dismiss,
}

/// Services a staff member performs, per the synced `service_staff` links. Empty links (nothing
/// synced yet) mean "unknown", reported as every service so the server stays the judge.
pub fn performed_services(store: &Store, staff_id: &str) -> Result<Vec<String>> {
    let links = store.service_staff()?;
    if links.is_empty() {
        return Ok(store.services()?.into_iter().map(|s| s.id).collect());
    }
    Ok(links
        .into_iter()
        .filter(|l| l.staff_id == staff_id)
        .map(|l| l.service_id)
        .collect())
}

/// Returns the new appointment id.
pub fn create_appointment(store: &mut Store, new: NewAppointment) -> Result<String> {
    if new.service_ids.is_empty() {
        return Err(CoreError::Invalid("pick at least one service".into()));
    }
    let known: Vec<String> = store.services()?.into_iter().map(|s| s.id).collect();
    if let Some(bad) = new.service_ids.iter().find(|id| !known.contains(id)) {
        return Err(CoreError::Invalid(format!("unknown service {bad}")));
    }
    if !store.staff()?.iter().any(|s| s.id == new.staff_id) {
        return Err(CoreError::Invalid(format!(
            "unknown staff member {}",
            new.staff_id
        )));
    }
    let performed = performed_services(store, &new.staff_id)?;
    if let Some(bad) = new.service_ids.iter().find(|id| !performed.contains(id)) {
        return Err(CoreError::Invalid(format!(
            "this staff member does not perform service {bad}"
        )));
    }
    if !known_clients(store)?
        .iter()
        .any(|(id, _)| *id == new.client_id)
    {
        return Err(CoreError::Invalid(format!(
            "unknown client {}",
            new.client_id
        )));
    }
    if let Some(notes) = &new.notes {
        check_len("notes", notes, MAX_NOTES)?;
    }
    let id = uuid::Uuid::now_v7().to_string();
    let mut p = Map::new();
    p.insert("id".into(), json!(id));
    p.insert("staffId".into(), json!(new.staff_id));
    p.insert("serviceIds".into(), json!(new.service_ids));
    p.insert("startsAt".into(), json!(iso(new.starts_at)));
    p.insert("clientId".into(), json!(new.client_id));
    if let Some(n) = new.notes.filter(|n| !n.trim().is_empty()) {
        p.insert("notes".into(), json!(n));
    }
    if new.override_notice {
        p.insert("override".into(), json!(true));
    }
    store.enqueue("appointment.create", &id, Value::Object(p))?;
    Ok(id)
}

fn editable(store: &Store, id: &str) -> Result<crate::model::Appointment> {
    let a = effective_appointment(store, id)?
        .ok_or_else(|| CoreError::NotFound(format!("appointment {id}")))?;
    if a.status != AppointmentStatus::Booked {
        return Err(CoreError::Invalid(format!(
            "appointment is {}",
            a.status.as_str()
        )));
    }
    Ok(a)
}

pub fn reschedule_appointment(
    store: &mut Store,
    id: &str,
    starts_at: Option<DateTime<Utc>>,
    staff_id: Option<&str>,
) -> Result<()> {
    if starts_at.is_none() && staff_id.is_none() {
        return Err(CoreError::Invalid(
            "provide a new time and/or staff member".into(),
        ));
    }
    let current = editable(store, id)?;
    let mut p = Map::new();
    p.insert("id".into(), json!(id));
    p.insert("version".into(), json!(current.version));
    if let Some(t) = starts_at {
        p.insert("startsAt".into(), json!(iso(t)));
    }
    if let Some(s) = staff_id {
        p.insert("staffId".into(), json!(s));
    }
    store.enqueue("appointment.reschedule", id, Value::Object(p))?;
    Ok(())
}

pub fn cancel_appointment(store: &mut Store, id: &str) -> Result<()> {
    let current = editable(store, id)?;
    store.enqueue(
        "appointment.cancel",
        id,
        json!({"id": id, "version": current.version}),
    )?;
    Ok(())
}

/// Returns the new client id.
pub fn create_client(store: &mut Store, name: &str, phone: Option<&str>) -> Result<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(CoreError::Invalid("a client needs a name".into()));
    }
    check_len("name", name, MAX_NAME)?;
    if let Some(ph) = phone {
        check_len("phone", ph.trim(), MAX_PHONE)?;
    }
    let id = uuid::Uuid::now_v7().to_string();
    let mut p = Map::new();
    p.insert("id".into(), json!(id));
    p.insert("name".into(), json!(name));
    if let Some(ph) = phone.map(str::trim).filter(|p| !p.is_empty()) {
        p.insert("phone".into(), json!(ph));
    }
    store.enqueue("client.create", &id, Value::Object(p))?;
    Ok(id)
}

pub fn resolve_conflict(
    store: &mut Store,
    mutation_id: &str,
    resolution: Resolution,
) -> Result<()> {
    let c = store
        .conflict(mutation_id)?
        .ok_or_else(|| CoreError::NotFound(format!("open conflict {mutation_id}")))?;
    match resolution {
        Resolution::Dismiss => store.resolve_conflict(mutation_id, "dismissed"),
        Resolution::Cancel => {
            if c.kind != "appointment.create" {
                // The appointment exists on the server (or did): cancel it if it is still live.
                if let Ok(a) = editable(store, &c.entity_id) {
                    store.enqueue(
                        "appointment.cancel",
                        &c.entity_id,
                        json!({"id": c.entity_id, "version": a.version}),
                    )?;
                }
            }
            store.resolve_conflict(mutation_id, "cancelled")
        }
        Resolution::Reschedule {
            starts_at,
            staff_id,
        } => {
            match c.kind.as_str() {
                "appointment.create" => {
                    // A rejection is final: same appointment id, new mutation id.
                    let mut p = c.payload.clone();
                    p["startsAt"] = json!(iso(starts_at));
                    if let Some(s) = staff_id {
                        p["staffId"] = json!(s);
                    }
                    store.enqueue("appointment.create", &c.entity_id, p)?;
                }
                "appointment.reschedule" => {
                    reschedule_appointment(
                        store,
                        &c.entity_id,
                        Some(starts_at),
                        staff_id.as_deref(),
                    )?;
                }
                other => {
                    return Err(CoreError::Invalid(format!("{other} cannot be rescheduled")));
                }
            }
            store.resolve_conflict(mutation_id, "rescheduled")
        }
    }
}
