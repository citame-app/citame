//! Offline behaviour of the read model and the user actions, against a real SQLite replica.

use chrono::{DateTime, NaiveDate, Utc};
use serde_json::json;

use crate::calendar::*;
use crate::model::*;
use crate::ops::*;
use crate::store::Store;

const ANA: &str = "01a1d81e-0000-7000-8000-000000000001";
const BEA: &str = "01a1d81e-0000-7000-8000-000000000002";
const CUT: &str = "01a1d81e-0000-7000-8000-0000000000a1";
const DRY: &str = "01a1d81e-0000-7000-8000-0000000000a2";
const LUCIA: &str = "01a1d81e-0000-7000-8000-0000000000c1";
const EXISTING: &str = "01a1d81e-0000-7000-8000-0000000000e1";

fn at(iso: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(iso)
        .unwrap()
        .with_timezone(&Utc)
}

fn day(s: &str) -> NaiveDate {
    s.parse().unwrap()
}

fn up(seq: i64, entity: &str, id: &str, data: serde_json::Value) -> RawChange {
    RawChange {
        seq,
        entity: entity.into(),
        id: id.into(),
        op: "upsert".into(),
        data: Some(data),
    }
}

const T0: &str = "2026-03-01T10:00:00.000Z";

fn seeded() -> Store {
    let mut s = Store::open_in_memory().unwrap();
    let changes = vec![
        up(
            1,
            "salon_settings",
            "1",
            json!({"name": "SoB", "timezone": "America/Argentina/Buenos_Aires",
            "slotGranularityMinutes": 15, "minNoticeMinutes": 60, "maxDaysAhead": 60, "updatedAt": T0}),
        ),
        up(
            2,
            "staff",
            ANA,
            json!({"id": ANA, "displayName": "Ana", "active": true, "userId": null, "updatedAt": T0}),
        ),
        up(
            3,
            "staff",
            BEA,
            json!({"id": BEA, "displayName": "Bea", "active": true, "userId": null, "updatedAt": T0}),
        ),
        up(
            4,
            "service",
            CUT,
            json!({"id": CUT, "name": "Haircut", "description": null, "durationMinutes": 45,
            "bufferMinutes": 15, "priceCents": 10000, "currency": "ARS", "active": true, "updatedAt": T0}),
        ),
        up(
            5,
            "service",
            DRY,
            json!({"id": DRY, "name": "Blow dry", "description": null, "durationMinutes": 30,
            "bufferMinutes": 0, "priceCents": 5000, "currency": "ARS", "active": true, "updatedAt": T0}),
        ),
        up(
            6,
            "client",
            LUCIA,
            json!({"id": LUCIA, "name": "Lucia", "phone": null, "email": null, "notes": null,
            "createdAt": T0, "updatedAt": T0}),
        ),
        up(
            7,
            "appointment",
            EXISTING,
            json!({"id": EXISTING, "staffId": ANA, "clientId": LUCIA,
            "startsAt": "2026-03-09T15:00:00.000Z", "endsAt": "2026-03-09T16:00:00.000Z", "status": "booked",
            "notes": null, "version": 3, "services": [], "createdAt": T0, "updatedAt": T0}),
        ),
    ];
    s.apply_page(&changes, 7).unwrap();
    s
}

fn new_appt(start: &str) -> NewAppointment {
    NewAppointment {
        staff_id: BEA.into(),
        service_ids: vec![CUT.into(), DRY.into()],
        starts_at: at(start),
        client_id: LUCIA.into(),
        notes: Some("first visit".into()),
        override_notice: false,
    }
}

fn column<'a>(v: &'a DayView, name: &str) -> &'a StaffColumn {
    v.columns
        .iter()
        .find(|c| c.staff.display_name == name)
        .unwrap()
}

#[test]
fn the_day_view_has_one_column_per_active_staff_with_server_appointments() {
    let s = seeded();
    let v = day_view(&s, day("2026-03-09")).unwrap();
    assert_eq!(v.timezone, "America/Argentina/Buenos_Aires");
    assert_eq!(
        v.columns
            .iter()
            .map(|c| c.staff.display_name.as_str())
            .collect::<Vec<_>>(),
        ["Ana", "Bea"]
    );
    let items = &column(&v, "Ana").items;
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].client_name, "Lucia");
    assert!(!items[0].pending && !items[0].conflict);
    assert!(column(&v, "Bea").items.is_empty());
}

#[test]
fn days_are_cut_in_the_salon_timezone_not_utc() {
    let mut s = seeded();
    // 02:00 UTC on the 9th is 23:00 on the 8th in Buenos Aires (UTC-3).
    s.apply_page(&[up(8, "appointment", "01a1d81e-0000-7000-8000-0000000000e2", json!({
        "id": "01a1d81e-0000-7000-8000-0000000000e2", "staffId": BEA, "clientId": LUCIA,
        "startsAt": "2026-03-09T02:00:00.000Z", "endsAt": "2026-03-09T03:00:00.000Z", "status": "booked",
        "notes": null, "version": 1, "services": [], "createdAt": T0, "updatedAt": T0}))], 8).unwrap();
    assert_eq!(
        column(&day_view(&s, day("2026-03-08")).unwrap(), "Bea")
            .items
            .len(),
        1
    );
    assert!(
        column(&day_view(&s, day("2026-03-09")).unwrap(), "Bea")
            .items
            .is_empty()
    );
    let (from, to) = local_day_range(salon_tz(&s).unwrap(), day("2026-03-09"));
    assert_eq!(from, at("2026-03-09T03:00:00Z"));
    assert_eq!(to, at("2026-03-10T03:00:00Z"));
}

#[test]
fn the_week_view_spans_seven_days() {
    let s = seeded();
    let w = week_view(&s, day("2026-03-09")).unwrap();
    assert_eq!(w.len(), 7);
    assert_eq!(w[0].date, day("2026-03-09"));
    assert_eq!(w[6].date, day("2026-03-15"));
    assert_eq!(column(&w[0], "Ana").items.len(), 1);
    assert!(column(&w[1], "Ana").items.is_empty());
}

#[test]
fn an_offline_booking_shows_up_pending_with_computed_end_and_queues_a_create() {
    let mut s = seeded();
    let id = create_appointment(&mut s, new_appt("2026-03-10T13:00:00Z")).unwrap();
    let v = day_view(&s, day("2026-03-10")).unwrap();
    let item = &column(&v, "Bea").items[0];
    assert_eq!(item.appointment.id, id);
    assert!(item.pending);
    assert_eq!(item.appointment.version, 1);
    assert_eq!(item.appointment.status, AppointmentStatus::Booked);
    // (45 + 15) + (30 + 0) minutes, like the server's totalBlockMinutes.
    assert_eq!(item.appointment.ends_at, at("2026-03-10T14:30:00Z"));
    assert_eq!(item.client_name, "Lucia");

    let q = s.outbox(10).unwrap();
    assert_eq!(q.len(), 1);
    assert_eq!(q[0].kind, "appointment.create");
    assert_eq!(q[0].payload["id"], json!(id));
    assert_eq!(q[0].payload["serviceIds"], json!([CUT, DRY]));
    assert_eq!(q[0].payload["startsAt"], json!("2026-03-10T13:00:00.000Z"));
    assert_eq!(q[0].payload["clientId"], json!(LUCIA));
    assert!(q[0].payload.get("override").is_none());
}

#[test]
fn booking_with_an_unknown_service_or_client_is_refused_locally() {
    let mut s = seeded();
    let mut bad = new_appt("2026-03-10T13:00:00Z");
    bad.service_ids = vec!["nope".into()];
    assert!(create_appointment(&mut s, bad).is_err());
    let mut bad = new_appt("2026-03-10T13:00:00Z");
    bad.service_ids = vec![];
    assert!(create_appointment(&mut s, bad).is_err());
    assert_eq!(s.outbox_len().unwrap(), 0);
}

#[test]
fn moving_an_appointment_offline_keeps_its_duration_and_bumps_the_local_version() {
    let mut s = seeded();
    reschedule_appointment(&mut s, EXISTING, Some(at("2026-03-09T17:00:00Z")), None).unwrap();
    let a = effective_appointment(&s, EXISTING).unwrap().unwrap();
    assert_eq!(a.starts_at, at("2026-03-09T17:00:00Z"));
    assert_eq!(a.ends_at, at("2026-03-09T18:00:00Z"));
    assert_eq!(a.version, 4);
    let q = s.outbox(10).unwrap();
    assert_eq!(q[0].kind, "appointment.reschedule");
    assert_eq!(q[0].payload["version"], json!(3));
    assert_eq!(q[0].payload["startsAt"], json!("2026-03-09T17:00:00.000Z"));
    assert!(day_view(&s, day("2026-03-09")).unwrap().columns[0].items[0].pending);
}

#[test]
fn queued_edits_of_one_appointment_carry_incrementing_versions() {
    let mut s = seeded();
    reschedule_appointment(&mut s, EXISTING, Some(at("2026-03-09T17:00:00Z")), None).unwrap();
    reschedule_appointment(&mut s, EXISTING, None, Some(BEA)).unwrap();
    cancel_appointment(&mut s, EXISTING).unwrap();
    let versions: Vec<_> = s
        .outbox(10)
        .unwrap()
        .iter()
        .map(|e| e.payload["version"].clone())
        .collect();
    assert_eq!(versions, vec![json!(3), json!(4), json!(5)]);
    assert_eq!(s.outbox(10).unwrap()[1].payload["staffId"], json!(BEA));
}

#[test]
fn cancelling_offline_hides_the_appointment_and_queues_a_cancel() {
    let mut s = seeded();
    cancel_appointment(&mut s, EXISTING).unwrap();
    assert!(
        column(&day_view(&s, day("2026-03-09")).unwrap(), "Ana")
            .items
            .is_empty()
    );
    assert_eq!(
        effective_appointment(&s, EXISTING).unwrap().unwrap().status,
        AppointmentStatus::Cancelled
    );
    assert_eq!(s.outbox(10).unwrap()[0].kind, "appointment.cancel");
}

#[test]
fn an_appointment_created_and_moved_offline_is_edited_in_the_overlay_only() {
    let mut s = seeded();
    let id = create_appointment(&mut s, new_appt("2026-03-10T13:00:00Z")).unwrap();
    reschedule_appointment(&mut s, &id, Some(at("2026-03-11T13:00:00Z")), None).unwrap();
    assert!(
        column(&day_view(&s, day("2026-03-10")).unwrap(), "Bea")
            .items
            .is_empty()
    );
    let view = day_view(&s, day("2026-03-11")).unwrap();
    let item = &column(&view, "Bea").items[0];
    assert!(item.pending);
    assert_eq!(item.appointment.version, 2);
    assert_eq!(s.outbox(10).unwrap()[1].payload["version"], json!(1));
}

#[test]
fn editing_an_unknown_appointment_is_refused() {
    let mut s = seeded();
    assert!(cancel_appointment(&mut s, "ghost").is_err());
    assert!(
        reschedule_appointment(&mut s, "ghost", Some(at("2026-03-11T13:00:00Z")), None).is_err()
    );
    assert!(reschedule_appointment(&mut s, EXISTING, None, None).is_err());
}

#[test]
fn a_pull_for_a_row_with_a_pending_edit_keeps_showing_the_local_version() {
    let mut s = seeded();
    reschedule_appointment(&mut s, EXISTING, Some(at("2026-03-09T17:00:00Z")), None).unwrap();
    // Somebody else changed the notes meanwhile; the server version moves to 4.
    s.apply_page(&[up(9, "appointment", EXISTING, json!({"id": EXISTING, "staffId": ANA, "clientId": LUCIA,
        "startsAt": "2026-03-09T15:00:00.000Z", "endsAt": "2026-03-09T16:00:00.000Z", "status": "booked",
        "notes": "vip", "version": 4, "services": [], "createdAt": T0, "updatedAt": T0}))], 9).unwrap();
    let a = effective_appointment(&s, EXISTING).unwrap().unwrap();
    assert_eq!(a.starts_at, at("2026-03-09T17:00:00Z"));
    assert_eq!(a.version, 5);
    assert_eq!(a.notes.as_deref(), Some("vip"));
}

#[test]
fn a_tombstone_removes_the_appointment_from_the_calendar() {
    let mut s = seeded();
    s.apply_page(
        &[RawChange {
            seq: 10,
            entity: "appointment".into(),
            id: EXISTING.into(),
            op: "delete".into(),
            data: None,
        }],
        10,
    )
    .unwrap();
    assert!(
        column(&day_view(&s, day("2026-03-09")).unwrap(), "Ana")
            .items
            .is_empty()
    );
}

#[test]
fn offline_clients_can_be_created_and_booked_in_order() {
    let mut s = seeded();
    let cid = create_client(&mut s, "Marta", Some("1155551234")).unwrap();
    let mut n = new_appt("2026-03-10T13:00:00Z");
    n.client_id = cid.clone();
    create_appointment(&mut s, n).unwrap();
    let q = s.outbox(10).unwrap();
    assert_eq!(
        q.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(),
        ["client.create", "appointment.create"]
    );
    let view = day_view(&s, day("2026-03-10")).unwrap();
    let item = &column(&view, "Bea").items[0];
    assert_eq!(item.client_name, "Marta");
}

fn reject(s: &mut Store, entry: &OutboxEntry, reason: &str) {
    let r = MutationResult::Rejected {
        mutation_id: entry.mutation_id.clone(),
        reason: reason.into(),
        message: "The selected time slot is no longer available".into(),
        replayed: false,
    };
    s.apply_push_results(std::slice::from_ref(entry), &[r])
        .unwrap();
}

#[test]
fn a_rejected_booking_becomes_a_conflict_and_leaves_the_calendar() {
    let mut s = seeded();
    let id = create_appointment(&mut s, new_appt("2026-03-10T13:00:00Z")).unwrap();
    let entry = s.outbox(1).unwrap().remove(0);
    reject(&mut s, &entry, "slot_taken");
    assert!(
        column(&day_view(&s, day("2026-03-10")).unwrap(), "Bea")
            .items
            .is_empty()
    );
    let c = s.conflicts().unwrap();
    assert_eq!(c.len(), 1);
    assert_eq!(c[0].entity_id, id);
    assert!(c[0].is_appointment());
    assert_eq!(
        sync_summary(&s).unwrap(),
        SyncSummary {
            pending: 0,
            conflicts: 1,
            cursor: 7
        }
    );
}

#[test]
fn resolving_a_rejected_booking_by_rescheduling_queues_a_fresh_create() {
    let mut s = seeded();
    let id = create_appointment(&mut s, new_appt("2026-03-10T13:00:00Z")).unwrap();
    let entry = s.outbox(1).unwrap().remove(0);
    reject(&mut s, &entry, "slot_taken");
    resolve_conflict(
        &mut s,
        &entry.mutation_id,
        Resolution::Reschedule {
            starts_at: at("2026-03-10T16:00:00Z"),
            staff_id: Some(ANA.into()),
        },
    )
    .unwrap();
    assert!(s.conflicts().unwrap().is_empty());
    let q = s.outbox(10).unwrap();
    assert_eq!(q.len(), 1);
    assert_ne!(
        q[0].mutation_id, entry.mutation_id,
        "a rejection is final: a new mutation id is required"
    );
    assert_eq!(q[0].kind, "appointment.create");
    assert_eq!(q[0].payload["id"], json!(id));
    assert_eq!(q[0].payload["startsAt"], json!("2026-03-10T16:00:00.000Z"));
    assert_eq!(q[0].payload["staffId"], json!(ANA));
    assert_eq!(q[0].payload["serviceIds"], json!([CUT, DRY]));
    assert!(column(&day_view(&s, day("2026-03-10")).unwrap(), "Ana").items[0].pending);
}

#[test]
fn cancelling_a_rejected_booking_just_drops_it() {
    let mut s = seeded();
    create_appointment(&mut s, new_appt("2026-03-10T13:00:00Z")).unwrap();
    let entry = s.outbox(1).unwrap().remove(0);
    reject(&mut s, &entry, "slot_taken");
    resolve_conflict(&mut s, &entry.mutation_id, Resolution::Cancel).unwrap();
    assert!(s.conflicts().unwrap().is_empty());
    assert_eq!(s.outbox_len().unwrap(), 0);
}

#[test]
fn a_rejected_move_can_be_rescheduled_again_with_the_fresh_server_version() {
    let mut s = seeded();
    reschedule_appointment(&mut s, EXISTING, Some(at("2026-03-09T17:00:00Z")), None).unwrap();
    let entry = s.outbox(1).unwrap().remove(0);
    reject(&mut s, &entry, "slot_taken");
    // The server copy is what the calendar shows again.
    assert_eq!(
        effective_appointment(&s, EXISTING)
            .unwrap()
            .unwrap()
            .starts_at,
        at("2026-03-09T15:00:00Z")
    );
    assert!(day_view(&s, day("2026-03-09")).unwrap().columns[0].items[0].conflict);
    resolve_conflict(
        &mut s,
        &entry.mutation_id,
        Resolution::Reschedule {
            starts_at: at("2026-03-09T19:00:00Z"),
            staff_id: None,
        },
    )
    .unwrap();
    let q = s.outbox(10).unwrap();
    assert_eq!(q[0].kind, "appointment.reschedule");
    assert_eq!(q[0].payload["version"], json!(3));
    assert_eq!(q[0].payload["startsAt"], json!("2026-03-09T19:00:00.000Z"));
}

#[test]
fn cancelling_after_a_rejected_move_cancels_the_appointment() {
    let mut s = seeded();
    reschedule_appointment(&mut s, EXISTING, Some(at("2026-03-09T17:00:00Z")), None).unwrap();
    let entry = s.outbox(1).unwrap().remove(0);
    reject(&mut s, &entry, "slot_taken");
    resolve_conflict(&mut s, &entry.mutation_id, Resolution::Cancel).unwrap();
    let q = s.outbox(10).unwrap();
    assert_eq!(q[0].kind, "appointment.cancel");
    assert_eq!(q[0].payload["version"], json!(3));
}

#[test]
fn dismissing_closes_a_conflict_without_queueing_anything() {
    let mut s = seeded();
    reschedule_appointment(&mut s, EXISTING, Some(at("2026-03-09T17:00:00Z")), None).unwrap();
    let entry = s.outbox(1).unwrap().remove(0);
    reject(&mut s, &entry, "conflict");
    resolve_conflict(&mut s, &entry.mutation_id, Resolution::Dismiss).unwrap();
    assert!(s.conflicts().unwrap().is_empty());
    assert_eq!(s.outbox_len().unwrap(), 0);
}

#[test]
fn the_sync_summary_counts_pending_edits() {
    let mut s = seeded();
    assert_eq!(
        sync_summary(&s).unwrap(),
        SyncSummary {
            pending: 0,
            conflicts: 0,
            cursor: 7
        }
    );
    cancel_appointment(&mut s, EXISTING).unwrap();
    assert_eq!(sync_summary(&s).unwrap().pending, 1);
}

#[test]
fn booking_requires_the_staff_member_to_perform_every_selected_service() {
    let mut s = seeded();
    let link = |seq: i64, id: &str, service: &str, staff: &str| {
        up(
            seq,
            "service_staff",
            id,
            json!({"id": id, "serviceId": service, "staffId": staff}),
        )
    };
    // Ana does both services; Bea only the haircut.
    s.apply_page(
        &[
            link(8, "l1", CUT, ANA),
            link(9, "l2", DRY, ANA),
            link(10, "l3", CUT, BEA),
        ],
        10,
    )
    .unwrap();
    let mut both_with_bea = new_appt("2026-03-10T13:00:00Z");
    both_with_bea.staff_id = BEA.into();
    assert!(create_appointment(&mut s, both_with_bea.clone()).is_err());
    assert_eq!(s.outbox_len().unwrap(), 0);
    both_with_bea.service_ids = vec![CUT.into()];
    assert!(create_appointment(&mut s, both_with_bea).is_ok());
    let mut with_ana = new_appt("2026-03-10T15:00:00Z");
    with_ana.staff_id = ANA.into();
    assert!(create_appointment(&mut s, with_ana).is_ok());
    assert_eq!(performed_services(&s, BEA).unwrap(), vec![CUT.to_string()]);
}
