//! User actions. Each one writes to the outbox first; the calendar shows it as pending at once.

use std::collections::{BTreeMap, BTreeSet};

use chrono::{DateTime, Duration, SecondsFormat, Utc};
use serde_json::{Map, Value, json};

use crate::calendar::{
    effective_appointment, effective_appointments_between, effective_time_off, known_clients,
    service_work_windows,
};
use crate::error::{CoreError, Result};
use crate::model::{
    Appointment, AppointmentService, AppointmentStatus, Client, Service, ServiceOption, TimeOff,
    WorkWindow,
};
use crate::store::Store;

/// Longest free text the API accepts (`LIMITS` in `packages/contracts`). Counted in UTF-16 code
/// units, the way the server's validation counts, so an emoji costs two.
const MAX_NAME: usize = 200;
const MAX_PHONE: usize = 32;
const MAX_NOTES: usize = 2000;
const MAX_REASON: usize = 500;

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

fn validate_block(
    store: &Store,
    staff_id: &str,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    reason: &str,
) -> Result<()> {
    if start >= end {
        return Err(CoreError::Invalid("The end must be after the start".into()));
    }
    if !store
        .staff()?
        .iter()
        .any(|member| member.id == staff_id && member.active)
    {
        return Err(CoreError::Invalid(
            "The professional is inactive or missing".into(),
        ));
    }
    check_len("reason", reason.trim(), MAX_REASON)
}

pub fn create_time_off(
    store: &mut Store,
    staff_id: &str,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    reason: &str,
) -> Result<String> {
    validate_block(store, staff_id, start, end, reason)?;
    let id = uuid::Uuid::now_v7().to_string();
    let mut payload =
        json!({"id": id, "staffId": staff_id, "startsAt": iso(start), "endsAt": iso(end)});
    if !reason.trim().is_empty() {
        payload["reason"] = json!(reason.trim());
    }
    store.enqueue("time_off.create", &id, payload)?;
    Ok(id)
}

fn verify_block(store: &Store, expected: &TimeOff) -> Result<()> {
    if !effective_time_off(store, expected.starts_at, expected.ends_at)?
        .iter()
        .any(|block| &block.time_off == expected)
    {
        return Err(CoreError::Invalid(
            "The block changed. Close it and open the latest version.".into(),
        ));
    }
    Ok(())
}

pub fn update_time_off(
    store: &mut Store,
    expected: &TimeOff,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    reason: &str,
) -> Result<()> {
    verify_block(store, expected)?;
    validate_block(store, &expected.staff_id, start, end, reason)?;
    let reason = (!reason.trim().is_empty()).then_some(reason.trim());
    if expected.starts_at == start
        && expected.ends_at == end
        && expected.reason.as_deref() == reason
    {
        return Ok(());
    }
    store.enqueue_after("time_off.update", &expected.id, json!({
        "id": expected.id, "staffId": expected.staff_id, "startsAt": iso(start), "endsAt": iso(end),
        "reason": reason, "expectedUpdatedAt": iso(expected.updated_at)
    }), expected.updated_at)?;
    Ok(())
}

pub fn delete_time_off(store: &mut Store, expected: &TimeOff) -> Result<()> {
    verify_block(store, expected)?;
    store.enqueue_after(
        "time_off.delete",
        &expected.id,
        json!({
            "id": expected.id, "staffId": expected.staff_id,
            "expectedUpdatedAt": iso(expected.updated_at)
        }),
        expected.updated_at,
    )?;
    Ok(())
}

type Slot = (DateTime<Utc>, DateTime<Utc>);

fn working_intervals((start, end): Slot, schedule: &[WorkWindow]) -> Vec<Slot> {
    let bounds = schedule
        .iter()
        .map(|window| {
            let from = start.checked_add_signed(Duration::try_minutes(window.offset_minutes)?)?;
            let to = start.checked_add_signed(Duration::try_minutes(window.end_offset_minutes)?)?;
            (from >= start && to <= end && from < to).then_some((from, to))
        })
        .collect::<Option<Vec<_>>>();
    bounds
        .filter(|items| !items.is_empty())
        .unwrap_or_else(|| vec![(start, end)])
}

fn ensure_local_slot(
    store: &Store,
    staff_id: &str,
    slot: Slot,
    windows: &[WorkWindow],
    exclude: Option<&str>,
) -> Result<()> {
    let (start, end) = slot;
    if effective_time_off(store, start, end)?
        .iter()
        .any(|block| block.time_off.staff_id == staff_id)
    {
        return Err(CoreError::TimeOffOverlap);
    }
    let staff = store
        .staff()?
        .into_iter()
        .find(|staff| staff.id == staff_id)
        .ok_or_else(|| CoreError::NotFound(format!("staff member {staff_id}")))?;
    let existing: Vec<_> = effective_appointments_between(store, start, end)?
        .into_iter()
        .filter(|appointment| {
            appointment.staff_id == staff_id && Some(appointment.id.as_str()) != exclude
        })
        .flat_map(|appointment| {
            working_intervals(
                (appointment.starts_at, appointment.ends_at),
                appointment.work_windows.as_deref().unwrap_or_default(),
            )
        })
        .collect();
    for (work_start, work_end) in working_intervals(slot, windows) {
        let mut changes = BTreeMap::new();
        for &(occupied_start, occupied_end) in &existing {
            let overlaps_from = occupied_start.max(work_start);
            let overlaps_until = occupied_end.min(work_end);
            if overlaps_from < overlaps_until {
                *changes.entry(overlaps_from).or_insert(0) += 1;
                *changes.entry(overlaps_until).or_insert(0) -= 1;
            }
        }
        let mut active = 0;
        for change in changes.into_values() {
            active += change;
            if active >= staff.max_concurrent.clamp(1, 6) {
                return Err(CoreError::StaffCapacityExceeded);
            }
        }
    }
    Ok(())
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

/// Apply queued assignments before a later booking enters the same ordered outbox.
pub fn performed_services(store: &Store, staff_id: &str) -> Result<Vec<String>> {
    let links = store.service_staff()?;
    let mut performed: BTreeSet<String> =
        if links.is_empty() && store.get_meta("calendar_snapshot_complete")?.is_none() {
            store.services()?.into_iter().map(|s| s.id).collect()
        } else {
            links
                .into_iter()
                .filter(|l| l.staff_id == staff_id)
                .map(|l| l.service_id)
                .collect()
        };
    for change in store.pending_service_assignments()? {
        match (
            change.reviewed_staff_ids.contains(staff_id),
            change.staff_ids.contains(staff_id),
        ) {
            (false, true) => {
                performed.insert(change.id);
            }
            (true, false) => {
                performed.remove(&change.id);
            }
            _ => {}
        }
    }
    Ok(performed.into_iter().collect())
}

/// Returns the new appointment id.
pub fn create_appointment(store: &mut Store, new: NewAppointment) -> Result<String> {
    store.write_transaction(|store| queue_appointment(store, new))
}

fn queue_appointment(store: &mut Store, new: NewAppointment) -> Result<String> {
    if !known_clients(store)?
        .iter()
        .any(|(id, _)| *id == new.client_id)
    {
        return Err(CoreError::Invalid(format!(
            "unknown client {}",
            new.client_id
        )));
    }
    let (quotes, reviewed) = reviewed_service_terms(store, &new)?;
    let id = uuid::Uuid::now_v7().to_string();
    let mut p = Map::new();
    p.insert("id".into(), json!(id));
    p.insert("staffId".into(), json!(new.staff_id));
    p.insert("serviceIds".into(), json!(new.service_ids));
    p.insert("serviceQuotes".into(), json!(quotes));
    p.insert("_reviewedServices".into(), json!(reviewed));
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

/// Match the server's ordered option rules before showing or queuing a combination.
pub fn validate_catalogue_selection<'a>(
    catalogue: &[Service],
    ids: impl IntoIterator<Item = &'a str>,
) -> Result<()> {
    let mut picked = std::collections::BTreeSet::new();
    let mut families = std::collections::BTreeSet::new();
    let mut base: Option<(&Service, &str)> = None;
    let mut currency = None;
    for id in ids {
        let row = catalogue
            .iter()
            .find(|row| row.id == id && row.active)
            .ok_or(CoreError::IncompatibleServices)?;
        if !picked.insert(id) || currency.is_some_and(|code| code != row.currency.as_str()) {
            return Err(CoreError::IncompatibleServices);
        }
        currency = Some(row.currency.as_str());
        let family = match &row.catalog {
            Some(ServiceOption::Addon {
                allowed_service_ids,
            }) => {
                if !base.is_some_and(|(previous, family)| {
                    allowed_service_ids.contains(&previous.id)
                        || allowed_service_ids.contains(family)
                }) {
                    return Err(CoreError::IncompatibleServices);
                }
                continue;
            }
            Some(ServiceOption::Variant {
                parent_service_id, ..
            }) => {
                if !catalogue.iter().any(|parent| {
                    parent.id == *parent_service_id && parent.active && parent.catalog.is_none()
                }) {
                    return Err(CoreError::IncompatibleServices);
                }
                parent_service_id.as_str()
            }
            None => id,
        };
        if !families.insert(family) {
            return Err(CoreError::IncompatibleServices);
        }
        base = Some((row, family));
    }
    Ok(())
}

pub(crate) fn reviewed_service_terms(
    store: &Store,
    new: &NewAppointment,
) -> Result<(BTreeMap<String, String>, Vec<AppointmentService>)> {
    if new.service_ids.is_empty() {
        return Err(CoreError::Invalid("pick at least one service".into()));
    }
    let catalog = store.services()?;
    validate_catalogue_selection(&catalog, new.service_ids.iter().map(String::as_str))?;
    if store
        .pending_service_edits()?
        .iter()
        .any(|edit| edit.affects_booking() && new.service_ids.contains(&edit.id))
    {
        return Err(CoreError::CatalogueEditPending);
    }
    for id in &new.service_ids {
        if store.pending_service_resources(id)?.is_some() {
            return Err(CoreError::CatalogueEditPending);
        }
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
    if let Some(notes) = &new.notes {
        check_len("notes", notes, MAX_NOTES)?;
    }
    let picked: Vec<_> = new
        .service_ids
        .iter()
        .filter_map(|id| catalog.iter().find(|row| &row.id == id))
        .collect();
    let mut quotes = BTreeMap::new();
    let mut reviewed = Vec::new();
    for source in picked {
        let Some(hash) = &source.quote_hash else {
            return Err(CoreError::Invalid(
                "Refresh the service catalogue before creating a booking".into(),
            ));
        };
        if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(CoreError::Invalid(
                "Refresh the service catalogue before creating a booking".into(),
            ));
        }
        quotes.insert(source.id.clone(), hash.clone());
        reviewed.push(AppointmentService {
            service_id: Some(source.id.clone()),
            name: source.name.clone(),
            duration_minutes: source.duration_minutes,
            buffer_minutes: source.buffer_minutes,
            price_cents: source.price_cents,
            source_unpriced: false,
            currency: source.currency.clone(),
            processing: source.processing.clone(),
        });
    }
    let duration: i64 = reviewed
        .iter()
        .map(|s| s.duration_minutes + s.buffer_minutes)
        .sum();
    ensure_local_slot(
        store,
        &new.staff_id,
        (new.starts_at, new.starts_at + Duration::minutes(duration)),
        &service_work_windows(&reviewed),
        None,
    )?;
    Ok((quotes, reviewed))
}

pub fn create_appointment_for_new_client(
    store: &mut Store,
    mut new: NewAppointment,
    name: &str,
    phone: Option<&str>,
) -> Result<String> {
    store.write_transaction(|store| {
        new.client_id = create_client(store, name, phone)?;
        queue_appointment(store, new)
    })
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

pub enum AppointmentEdit<'a> {
    Move {
        starts_at: Option<DateTime<Utc>>,
        staff_id: Option<&'a str>,
    },
    Cancel,
    Outcome {
        status: AppointmentStatus,
        now: DateTime<Utc>,
    },
}

pub struct ReviewedAppointment {
    version: i64,
    pub starts_at: DateTime<Utc>,
    ends_at: DateTime<Utc>,
    pub staff_id: String,
    status: AppointmentStatus,
}

impl From<&Appointment> for ReviewedAppointment {
    fn from(appointment: &Appointment) -> Self {
        Self {
            version: appointment.version,
            starts_at: appointment.starts_at,
            ends_at: appointment.ends_at,
            staff_id: appointment.staff_id.clone(),
            status: appointment.status,
        }
    }
}

impl ReviewedAppointment {
    pub fn matches(&self, appointment: &Appointment) -> bool {
        self.version == appointment.version
            && self.starts_at == appointment.starts_at
            && self.ends_at == appointment.ends_at
            && self.staff_id == appointment.staff_id
            && self.status == appointment.status
    }
}

/// Uses the version shown to the operator, including earlier pending local edits.
pub fn queue_reviewed_appointment_edit(
    store: &mut Store,
    id: &str,
    reviewed: &ReviewedAppointment,
    edit: AppointmentEdit<'_>,
    conflict_to_resolve: Option<&str>,
) -> Result<()> {
    store.write_transaction(|store| {
        if effective_appointment(store, id)?.is_none_or(|a| !reviewed.matches(&a)) {
            return Err(CoreError::AppointmentChanged);
        }
        if let Some(mutation_id) = conflict_to_resolve
            && store
                .conflict(mutation_id)?
                .is_none_or(|conflict| conflict.entity_id != id)
        {
            return Err(CoreError::NotFound(format!("open conflict {mutation_id}")));
        }
        match edit {
            AppointmentEdit::Move {
                starts_at,
                staff_id,
            } => queue_reschedule(store, id, starts_at, staff_id),
            AppointmentEdit::Cancel => cancel_appointment(store, id),
            AppointmentEdit::Outcome { status, now } => {
                set_appointment_status(store, id, status, now)
            }
        }?;
        if let Some(mutation_id) = conflict_to_resolve {
            store.resolve_conflict(mutation_id, "reviewed")?;
        }
        Ok(())
    })
}

pub fn reschedule_appointment(
    store: &mut Store,
    id: &str,
    starts_at: Option<DateTime<Utc>>,
    staff_id: Option<&str>,
) -> Result<()> {
    store.write_transaction(|store| queue_reschedule(store, id, starts_at, staff_id))
}

fn queue_reschedule(
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
    let start = starts_at.unwrap_or(current.starts_at);
    let target = staff_id.unwrap_or(&current.staff_id);
    if target != current.staff_id || start != current.starts_at {
        let assigned = performed_services(store, target)?;
        if current
            .services
            .iter()
            .filter_map(|service| service.service_id.as_ref())
            .any(|id| !assigned.contains(id))
        {
            return Err(CoreError::Invalid(
                "This staff member does not perform every service in the appointment".into(),
            ));
        }
    }
    ensure_local_slot(
        store,
        target,
        (start, start + (current.ends_at - current.starts_at)),
        current.work_windows.as_deref().unwrap_or_default(),
        Some(id),
    )?;
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

/// Records an outcome offline; the API rechecks the time, role and version at synchronization.
pub fn set_appointment_status(
    store: &mut Store,
    id: &str,
    status: AppointmentStatus,
    now: DateTime<Utc>,
) -> Result<()> {
    if !matches!(
        status,
        AppointmentStatus::Completed | AppointmentStatus::NoShow
    ) {
        return Err(CoreError::Invalid("choose completed or no_show".into()));
    }
    let current = editable(store, id)?;
    if current.starts_at > now {
        return Err(CoreError::Invalid(
            "an outcome can only be recorded once the appointment starts".into(),
        ));
    }
    store.enqueue(
        "appointment.set_status",
        id,
        json!({ "id": id, "version": current.version, "status": status.as_str() }),
    )?;
    Ok(())
}

/// Returns the new client id.
pub fn create_client(store: &mut Store, name: &str, phone: Option<&str>) -> Result<String> {
    enqueue_client(store, name, phone, None, None)
}

pub fn create_directory_client(
    store: &mut Store,
    name: &str,
    phone: &str,
    email: &str,
    notes: &str,
) -> Result<String> {
    require_directory(store)?;
    let email = validate_directory_email(email)?;
    check_len("notes", notes, MAX_NOTES)?;
    enqueue_client(store, name, Some(phone), email, Some(notes))
}

fn validate_directory_email(email: &str) -> Result<Option<&str>> {
    let email = email.trim();
    check_len("email", email, 254)?;
    if !email.is_empty()
        && (email.chars().any(char::is_whitespace)
            || !email.split_once('@').is_some_and(|(name, domain)| {
                !name.is_empty() && !domain.contains('@') && domain.split('.').count() > 1
            }))
    {
        return Err(CoreError::Invalid("Enter a valid email address".into()));
    }
    Ok((!email.is_empty()).then_some(email))
}

fn require_directory(store: &Store) -> Result<()> {
    if !store.client_directory_enabled()? {
        return Err(CoreError::Invalid(
            "The client directory is unavailable".into(),
        ));
    }
    Ok(())
}

pub(crate) fn validate_contact(name: &str, phone: Option<&str>) -> Result<()> {
    if name.is_empty() {
        return Err(CoreError::Invalid("a client needs a name".into()));
    }
    check_len("name", name, MAX_NAME)?;
    if let Some(ph) = phone {
        check_len("phone", ph, MAX_PHONE)?;
        if ph.encode_utf16().count() < 3 {
            return Err(CoreError::Invalid(
                "A phone number needs at least 3 characters".into(),
            ));
        }
    }
    Ok(())
}

fn enqueue_client(
    store: &mut Store,
    name: &str,
    phone: Option<&str>,
    email: Option<&str>,
    notes: Option<&str>,
) -> Result<String> {
    let name = name.trim();
    let phone = phone.map(str::trim).filter(|value| !value.is_empty());
    validate_contact(name, phone)?;
    let id = uuid::Uuid::now_v7().to_string();
    let mut p = Map::new();
    p.insert("id".into(), json!(id));
    p.insert("name".into(), json!(name));
    if let Some(ph) = phone {
        p.insert("phone".into(), json!(ph));
    }
    if let Some(email) = email.filter(|value| !value.is_empty()) {
        p.insert("email".into(), json!(email));
    }
    if let Some(notes) = notes.filter(|value| !value.trim().is_empty()) {
        p.insert("notes".into(), json!(notes));
    }
    store.enqueue("client.create", &id, Value::Object(p))?;
    Ok(id)
}

pub fn update_directory_client(
    store: &mut Store,
    expected: &Client,
    name: &str,
    phone: &str,
    email: Option<&str>,
    notes: &str,
) -> Result<()> {
    require_directory(store)?;
    let name = name.trim();
    let phone = (!phone.trim().is_empty()).then(|| phone.trim());
    let notes = (!notes.trim().is_empty()).then_some(notes);
    validate_contact(name, phone)?;
    if let Some(notes) = notes {
        check_len("notes", notes, MAX_NOTES)?;
    }
    let id = &expected.id;
    if store
        .outbox(usize::MAX)?
        .iter()
        .any(|entry| entry.entity_id == *id)
    {
        return Err(CoreError::Invalid(
            "Wait for this contact to sync before editing it again".into(),
        ));
    }
    let latest = store.clients()?.into_iter().find(|client| client.id == *id);
    if latest.is_none_or(|client| !client.same_contact(expected))
        || expected.merged_into_id.is_some()
    {
        return Err(CoreError::Invalid(
            "The contact changed. Reopen its latest version.".into(),
        ));
    }
    let mut body = json!({"id":id,"expectedUpdatedAt":iso(expected.updated_at)});
    if name != expected.name {
        body["name"] = json!(name);
    }
    if phone != expected.phone.as_deref() {
        body["phone"] = json!(phone);
    }
    if let Some(raw) = email
        && raw != expected.email.as_deref().unwrap_or_default()
        && (!raw.trim().is_empty()).then_some(raw.trim()) != expected.email.as_deref()
    {
        if !expected.email_editable {
            return Err(CoreError::Invalid("This contact email is read-only".into()));
        }
        body["emailChange"] = json!({
            "email": validate_directory_email(raw)?,
            "expectedUpdatedAt": iso(expected.updated_at),
        });
    }
    if notes != expected.notes.as_deref() {
        body["notes"] = json!(notes);
    }
    if body.as_object().is_some_and(|fields| fields.len() > 2) {
        store.enqueue_after("client.update", id, body, expected.updated_at)?;
    }
    Ok(())
}

pub fn resolve_conflict(
    store: &mut Store,
    mutation_id: &str,
    resolution: Resolution,
) -> Result<()> {
    store.write_transaction(|store| resolve_conflict_in_transaction(store, mutation_id, resolution))
}

fn resolve_conflict_in_transaction(
    store: &mut Store,
    mutation_id: &str,
    resolution: Resolution,
) -> Result<()> {
    let c = store
        .conflict(mutation_id)?
        .ok_or_else(|| CoreError::NotFound(format!("open conflict {mutation_id}")))?;
    if c.requires_restored_review() && !matches!(resolution, Resolution::Dismiss) {
        return Err(CoreError::Invalid(
            "Review the restored calendar before making a new change".into(),
        ));
    }
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
                    if c.reason == "conflict" {
                        return Err(CoreError::Invalid("The reviewed booking terms changed; drop this proposal and review a new booking".into()));
                    }
                    // A rejection is final: same appointment id, new mutation id.
                    let mut p = c.payload.clone();
                    p["startsAt"] = json!(iso(starts_at));
                    if let Some(s) = staff_id {
                        p["staffId"] = json!(s);
                    }
                    if let Some((staff_id, services)) = p
                        .get("staffId")
                        .and_then(Value::as_str)
                        .zip(p.get("_reviewedServices"))
                    {
                        let reviewed: Vec<AppointmentService> =
                            serde_json::from_value(services.clone())?;
                        let duration: i64 = reviewed
                            .iter()
                            .map(|s| s.duration_minutes + s.buffer_minutes)
                            .sum();
                        ensure_local_slot(
                            store,
                            staff_id,
                            (starts_at, starts_at + Duration::minutes(duration)),
                            &service_work_windows(&reviewed),
                            Some(&c.entity_id),
                        )?;
                    }
                    store.enqueue("appointment.create", &c.entity_id, p)?;
                }
                "appointment.reschedule" => {
                    queue_reschedule(store, &c.entity_id, Some(starts_at), staff_id.as_deref())?;
                }
                other => {
                    return Err(CoreError::Invalid(format!("{other} cannot be rescheduled")));
                }
            }
            store.resolve_conflict(mutation_id, "rescheduled")
        }
    }
}
