//! Offline behaviour of the read model and the user actions, against a real SQLite replica.

use chrono::{DateTime, NaiveDate, Utc};
use serde_json::json;

use crate::calendar::{self, *};
use crate::model::*;
use crate::ops::{self, *};
use crate::store::Store;

const ANA: &str = "01a1d81e-0000-7000-8000-000000000001";
const BEA: &str = "01a1d81e-0000-7000-8000-000000000002";
const CUT: &str = "01a1d81e-0000-7000-8000-0000000000a1";
const DRY: &str = "01a1d81e-0000-7000-8000-0000000000a2";
const LUCIA: &str = "01a1d81e-0000-7000-8000-0000000000c1";
const EXISTING: &str = "01a1d81e-0000-7000-8000-0000000000e1";

#[test]
fn directory_groups_backfill_keeps_contacts_and_pending_edits() {
    let temporary = tempfile::tempdir().unwrap();
    let file = temporary.path().join("replica.sqlite");
    let mut replica = Store::open(&file).unwrap();
    replica.set_meta("client_directory", "allowed").unwrap();
    let mut client = seeded().clients().unwrap().remove(0);
    let incoming = |seq, client: &Client| up(seq, "client", &client.id, json!(client));
    replica.apply_page(&[incoming(19, &client)], 19).unwrap();
    let id = create_directory_client(&mut replica, "Pending contact", "", "", "").unwrap();
    drop(replica);
    let old_schema = rusqlite::Connection::open(&file).unwrap();
    old_schema
        .execute_batch(
            "DROP TABLE local_calendar_ack;
             ALTER TABLE booking_notice DROP COLUMN kind;
             DROP INDEX client_missing_group_names;
             DROP INDEX appointment_visit_group;
             DROP INDEX appointment_itinerary;",
        )
        .unwrap();
    old_schema.pragma_update(None, "user_version", 6).unwrap();
    drop(old_schema);
    let mut replica = Store::open(&file).unwrap();
    assert_eq!(replica.cursor().unwrap(), 19);
    let generation = replica.replica_generation().unwrap();
    assert_eq!(replica.client_groups_cursor().unwrap(), Some(0));
    assert_eq!(replica.outbox_len().unwrap(), 1);
    let clients = directory_clients(&replica).unwrap();
    assert!(directory_groups(&clients.clients).is_none());
    assert_eq!(search_directory(&clients, "pending", None)[0].id, id);

    client.group_names = Some(vec!["vip".into()]);
    assert_eq!(
        replica
            .apply_client_group_page(&[incoming(19, &client)], 19, &generation)
            .unwrap(),
        1
    );
    assert_eq!(replica.cursor().unwrap(), 19);
    assert_eq!(replica.client_groups_cursor().unwrap(), None);
    let clients = directory_clients(&replica).unwrap();
    assert_eq!(
        directory_groups(&clients.clients).unwrap(),
        std::collections::BTreeMap::from([("vip", 1)])
    );
    assert_eq!(search_directory(&clients, "VIP", None)[0].id, client.id);
    assert_eq!(search_directory(&clients, "", Some("vip"))[0].id, client.id);
    assert!(search_directory(&clients, "%", Some("vip")).is_empty());
}

#[test]
fn directory_search_finds_the_active_contact_through_merged_aliases() {
    let mut store = seeded();
    store.set_meta("client_directory", "allowed").unwrap();
    let mut active = store.clients().unwrap().remove(0);
    active.group_names = Some(vec!["vip".into()]);
    active.phone = Some("+9 7-5".into());
    let mut previous = active.clone();
    previous.id = "also-known-as".into();
    previous.name = "Previous name".into();
    previous.merged_into_id = Some(active.id.clone());
    previous.group_names = Some(vec!["archived-group".into()]);
    let mut oldest = previous.clone();
    oldest.id = "original-name".into();
    oldest.name = "Oldest name".into();
    oldest.phone = Some("+34 6-1".into());
    oldest.email = Some("history@example.test".into());
    oldest.merged_into_id = Some(previous.id.clone());
    let changes = [active.clone(), previous, oldest]
        .iter()
        .enumerate()
        .map(|(index, client)| up(30 + index as i64, "client", &client.id, json!(client)))
        .collect::<Vec<_>>();
    store.apply_page(&changes, 32).unwrap();

    let directory = directory_clients(&store).unwrap();
    for query in [
        "previous name",
        "oldest name",
        "346",
        "75",
        "HISTORY@example.test",
    ] {
        assert_eq!(search_directory(&directory, query, Some("vip")), [&active]);
    }
    assert!(search_directory(&directory, "61", Some("vip")).is_empty());
    assert!(search_directory(&directory, "Other client 346", None).is_empty());
    assert!(search_directory(&directory, "oldest name", Some("archived-group")).is_empty());
    assert!(search_directory(&directory, "archived-group", None).is_empty());
    assert_eq!(directory_groups(&directory.clients).unwrap()["vip"], 1);
}

#[test]
fn a_persisted_client_controls_revision_is_read_without_reloading_the_directory() {
    let mut store = seeded();
    assert!(store.client_is_synced(LUCIA).unwrap());
    assert_eq!(store.client_controls_revision(LUCIA).unwrap(), None);
    let mut client = store.clients().unwrap().remove(0);
    client.controls_version = Some(4);
    store
        .apply_page(&[up(20, "client", LUCIA, json!(client))], 20)
        .unwrap();
    assert_eq!(store.client_controls_revision(LUCIA).unwrap(), Some(4));
}

fn at(iso: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(iso)
        .unwrap()
        .with_timezone(&Utc)
}

fn day(s: &str) -> NaiveDate {
    s.parse().unwrap()
}

#[test]
fn a_local_day_uses_the_exact_end_of_a_gap_at_midnight() {
    let boundary = at("1985-12-31T18:30:00Z");
    assert_eq!(
        local_day_range(chrono_tz::Asia::Kathmandu, day("1985-12-31")).1,
        boundary
    );
    assert_eq!(
        local_day_range(chrono_tz::Asia::Kathmandu, day("1986-01-01")).0,
        boundary
    );
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

#[test]
fn a_reviewed_offline_service_edit_reopens_without_mutating_the_booking_replica() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("reviewed-catalogue.sqlite");
    let mut store = Store::open(&path).unwrap();
    seed(&mut store);
    let wire_row = |price_cents, version| {
        json!({
            "id": CUT, "name": "Haircut", "description": null, "category": "Hair",
            "priceCents": price_cents, "currency": "ARS", "sortOrder": 0, "onlineBooking": true,
            "durationMinutes": 45, "bufferMinutes": 15, "active": true,
            "updatedAt": T0, "version": version, "quoteHash": "a".repeat(64),
        })
    };
    store
        .apply_page(&[up(10, "service", CUT, wire_row(1200, 1))], 10)
        .unwrap();
    let review = store.reviewed_catalogue().unwrap();
    let original = review.services.iter().find(|row| row.id == CUT).unwrap();
    let mut proposed = original.details.clone();
    proposed.name = "🔔".repeat(101);
    assert!(
        store
            .queue_service_edit(
                &review.generation,
                original,
                &proposed,
                &original.staff_ids,
                None,
                None
            )
            .is_err()
    );
    assert!(store.outbox(1).unwrap().is_empty());
    proposed.name = original.details.name.clone();
    proposed.price_cents = 2000;
    assert!(
        store
            .queue_service_edit(
                &review.generation,
                original,
                &proposed,
                &original.staff_ids,
                None,
                None
            )
            .unwrap()
    );
    let separate_assignment = crate::store::ServiceAssignment {
        id: CUT.into(),
        reviewed_staff_ids: original.staff_ids.clone(),
        staff_ids: [ANA.into()].into(),
    };
    assert!(
        store
            .queue_service_assignment(&review.generation, &separate_assignment, None)
            .is_err()
    );
    assert!(
        store
            .queue_service_edit(
                &review.generation,
                original,
                &proposed,
                &original.staff_ids,
                None,
                None
            )
            .is_err()
    );
    drop(store);
    let mut reopened = Store::open(&path).unwrap();
    let pending = reopened.pending_service_edits().unwrap();
    assert_eq!(pending[0].proposal().unwrap(), proposed);
    assert_eq!(
        reopened
            .services()
            .unwrap()
            .iter()
            .find(|row| row.id == CUT)
            .unwrap()
            .price_cents,
        1200
    );
    let booking = new_appt("2026-03-10T13:00:00Z");
    assert!(matches!(
        reviewed_service_terms(&reopened, &booking, None),
        Err(crate::error::CoreError::CatalogueEditPending)
    ));
    let mut unaffected_booking = booking;
    unaffected_booking.service_ids = vec![DRY.into()];
    assert!(reviewed_service_terms(&reopened, &unaffected_booking, None).is_ok());
    let entry = reopened.outbox(1).unwrap().pop().unwrap();
    assert_eq!(
        entry.to_wire().payload,
        json!({"id":CUT,"version":1,"service":{"priceCents":2000}})
    );
    reopened
        .apply_push_results(
            std::slice::from_ref(&entry),
            &[MutationResult::Rejected {
                mutation_id: entry.mutation_id.clone(),
                reason: "conflict".into(),
                message: "Service changed".into(),
                replayed: false,
            }],
        )
        .unwrap();
    reopened
        .apply_page(&[up(11, "service", CUT, wire_row(1800, 2))], 11)
        .unwrap();
    assert!(matches!(
        reopened.queue_service_edit(
            &review.generation,
            original,
            &proposed,
            &original.staff_ids,
            None,
            Some(&entry.mutation_id)
        ),
        Err(crate::error::CoreError::CatalogueVersionChanged)
    ));
    let current = reopened.reviewed_catalogue().unwrap();
    let row = current.services.iter().find(|row| row.id == CUT).unwrap();
    assert!(
        reopened
            .queue_service_edit(
                &current.generation,
                row,
                &proposed,
                &row.staff_ids,
                None,
                Some(&entry.mutation_id)
            )
            .unwrap()
    );
    assert_eq!(
        reopened.outbox(1).unwrap()[0].to_wire().payload["version"],
        2
    );
    assert!(reopened.conflicts().unwrap().is_empty());
}

#[test]
fn a_combined_conflict_can_be_reviewed_when_only_its_team_catches_up() {
    let mut store = seeded();
    store.apply_page(&[up(8, "service", CUT, json!({
        "id": CUT, "name": "Haircut", "durationMinutes": 45, "bufferMinutes": 15,
        "priceCents": 1200, "currency": "ARS", "active": true, "updatedAt": T0, "version": 3,
        "sortOrder": 0, "onlineBooking": true
    }))], 8).unwrap();
    let original = store.reviewed_catalogue().unwrap();
    let base = &original.services[0];
    let local_team = [ANA.into()].into();
    store
        .queue_service_edit(
            &original.generation,
            base,
            &base.details,
            &local_team,
            None,
            None,
        )
        .unwrap();
    let draft = store.outbox(1).unwrap().pop().unwrap();
    assert!(draft.to_wire().payload.get("service").is_none());
    store
        .apply_push_results(
            std::slice::from_ref(&draft),
            &[MutationResult::Rejected {
                mutation_id: draft.mutation_id.clone(),
                reason: "conflict".into(),
                message: "Cloud team changed".into(),
                replayed: false,
            }],
        )
        .unwrap();
    let replace = Some(draft.mutation_id.as_str());
    assert!(matches!(
        store.queue_service_edit(
            &original.generation,
            base,
            &base.details,
            &local_team,
            None,
            replace
        ),
        Err(crate::error::CoreError::CatalogueVersionChanged)
    ));

    store
        .apply_page(
            &[up(
                9,
                "service_staff",
                "bea-cut",
                json!({
                    "id": "bea-cut", "serviceId": CUT, "staffId": BEA,
                }),
            )],
            9,
        )
        .unwrap();
    let updated = store.reviewed_catalogue().unwrap();
    let current = &updated.services[0];
    assert_eq!(current.version, base.version);
    let reviewed_team =
        crate::store::ServiceAssignment::reapply(&base.staff_ids, &local_team, &current.staff_ids);
    store
        .queue_service_edit(
            &updated.generation,
            current,
            &current.details,
            &reviewed_team,
            None,
            replace,
        )
        .unwrap();
    let pending = store.pending_service_edits().unwrap().pop().unwrap();
    assert_eq!(
        pending.assignment.unwrap().staff_ids,
        [ANA.into(), BEA.into()].into()
    );
    assert!(store.conflicts().unwrap().is_empty());
}

#[test]
fn a_catalogue_creation_reopens_with_its_exact_request_and_is_not_bookable_before_sync() {
    use crate::http::ServiceCreation;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("catalogue.sqlite");
    let mut store = Store::open(&path).unwrap();
    seed(&mut store);
    let id = uuid::Uuid::now_v7().to_string();
    let creation: ServiceCreation = serde_json::from_value(json!({
        "id": id,
        "service": {
            "name": "Local treatment", "durationMinutes": 30, "bufferMinutes": 5,
            "priceCents": 2900, "currency": "EUR", "sortOrder": 0, "onlineBooking": true,
            "active": true, "staffIds": [ANA]
        }
    }))
    .unwrap();
    let generation = store.verified_reviewed_generation().unwrap();
    store.remember_catalogue_access(&generation).unwrap();
    assert!(
        store
            .queue_service_creation("previous", &creation, None)
            .is_err()
    );
    store
        .queue_service_creation(&generation, &creation, None)
        .unwrap();
    assert!(
        store
            .queue_service_creation(&generation, &creation, None)
            .is_err()
    );
    let original = store.outbox(10).unwrap().pop().unwrap().to_wire();
    drop(store);
    let saved = Store::open(&path).unwrap();
    assert!(saved.cached_catalogue_access());
    assert_eq!(saved.pending_service_creations().unwrap(), vec![creation]);
    assert_eq!(saved.outbox(10).unwrap().pop().unwrap().to_wire(), original);
    assert!(saved.services().unwrap().iter().all(|row| row.id != id));
}

#[test]
fn the_offline_calendar_excludes_invalid_option_order_and_compatible_families_repeat_once() {
    let mut store = Store::open_in_memory().unwrap();
    seed(&mut store);
    let mut services = store.services().unwrap();
    let base = services.iter().find(|row| row.id == CUT).unwrap().clone();
    let mut extra = base.clone();
    extra.id = "extra".into();
    extra.catalog = Some(ServiceOption::Addon {
        allowed_service_ids: [CUT.into()].into(),
    });
    let mut variant = base.clone();
    variant.id = "variant".into();
    variant.catalog = Some(ServiceOption::Variant {
        parent_service_id: CUT.into(),
        option_label: "Long".into(),
    });
    services.extend([extra, variant]);
    assert!(ops::validate_catalogue_selection(&services, ["extra"]).is_err());
    assert!(ops::validate_catalogue_selection(&services, [DRY, "extra"]).is_err());
    assert!(ops::validate_catalogue_selection(&services, [CUT, "variant"]).is_err());
    assert!(ops::validate_catalogue_selection(&services, ["variant", "extra"]).is_ok());
}

#[test]
fn service_assignment_survives_restart_and_requires_review_on_a_changed_team() {
    use crate::store::{AssignmentWork, ServiceAssignment};

    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("replica.sqlite");
    let mut store = Store::open(&path).unwrap();
    seed(&mut store);
    let link = |seq, id, staff| {
        up(
            seq,
            "service_staff",
            id,
            json!({"id": id, "serviceId": CUT, "staffId": staff}),
        )
    };
    store.apply_page(&[link(8, "ana-cut", ANA)], 8).unwrap();
    let baseline = store.service_assignment(CUT).unwrap();
    let change = ServiceAssignment {
        id: CUT.into(),
        reviewed_staff_ids: baseline.staff_ids.clone(),
        staff_ids: [BEA.into()].into(),
    };
    store
        .queue_service_assignment(&baseline.generation, &change, None)
        .unwrap();
    assert!(
        store
            .queue_service_assignment(&baseline.generation, &change, None)
            .is_err()
    );
    drop(store);

    let mut store = Store::open(&path).unwrap();
    assert_eq!(
        store.service_assignment(CUT).unwrap().work,
        AssignmentWork::Pending(change.clone())
    );
    assert!(performed_services(&store, ANA).unwrap().is_empty());
    assert_eq!(performed_services(&store, BEA).unwrap(), vec![CUT]);
    let queued = store.outbox(1).unwrap();
    let rejected = MutationResult::Rejected {
        mutation_id: queued[0].mutation_id.clone(),
        reason: "conflict".into(),
        message: "changed".into(),
        replayed: false,
    };
    store.apply_push_results(&queued, &[rejected]).unwrap();
    store.apply_page(&[link(9, "bea-cut", BEA)], 9).unwrap();
    let refreshed = store.service_assignment(CUT).unwrap();
    let AssignmentWork::Conflict {
        id,
        change: rejected,
    } = refreshed.work
    else {
        panic!("expected saved proposal");
    };
    assert_eq!(change, rejected);
    assert!(
        store
            .queue_service_assignment(&refreshed.generation, &change, Some(&id))
            .is_err()
    );
    let reviewed = ServiceAssignment {
        staff_ids: change.proposed_on(&refreshed.staff_ids),
        reviewed_staff_ids: refreshed.staff_ids,
        ..change
    };
    store
        .queue_service_assignment(&refreshed.generation, &reviewed, Some(&id))
        .unwrap();
    assert!(store.conflicts().unwrap().is_empty());
    assert_eq!(
        store.service_assignment(CUT).unwrap().work,
        AssignmentWork::Pending(reviewed)
    );
}

#[test]
fn a_confirmed_empty_team_is_unavailable_and_pending_changes_can_be_revised_offline() {
    use crate::store::ServiceAssignment;

    let mut store = seeded();
    store.set_meta("calendar_snapshot_complete", "1").unwrap();
    assert!(performed_services(&store, ANA).unwrap().is_empty());
    assert!(create_appointment(&mut store, new_appt("2026-03-10T15:00:00Z")).is_err());
    let base = store.service_assignment(CUT).unwrap();
    let first = ServiceAssignment {
        id: CUT.into(),
        reviewed_staff_ids: base.staff_ids,
        staff_ids: [ANA.into()].into(),
    };
    store
        .queue_service_assignment(&base.generation, &first, None)
        .unwrap();
    assert_eq!(performed_services(&store, ANA).unwrap(), vec![CUT]);
    let latest = store.service_assignment(CUT).unwrap();
    let second = ServiceAssignment {
        id: CUT.into(),
        reviewed_staff_ids: latest.reviewed_team().clone(),
        staff_ids: [BEA.into()].into(),
    };
    store
        .queue_service_assignment(&latest.generation, &second, None)
        .unwrap();
    assert!(performed_services(&store, ANA).unwrap().is_empty());
    assert_eq!(performed_services(&store, BEA).unwrap(), vec![CUT]);
    let mut booking = new_appt("2026-03-10T15:00:00Z");
    booking.service_ids = vec![CUT.into()];
    let booking_id = create_appointment(&mut store, booking).unwrap();
    assert!(reschedule_appointment(&mut store, &booking_id, None, Some(ANA)).is_err());
    let queue = store.outbox(10).unwrap();
    assert_eq!(
        queue
            .iter()
            .map(|entry| entry.kind.as_str())
            .collect::<Vec<_>>(),
        [
            "service.staff_replace",
            "service.staff_replace",
            "appointment.create"
        ]
    );
    let prior = &queue[..2];
    let rejected = prior
        .iter()
        .map(|entry| MutationResult::Rejected {
            mutation_id: entry.mutation_id.clone(),
            reason: "conflict".into(),
            message: "Cloud team changed".into(),
            replayed: false,
        })
        .collect::<Vec<_>>();
    store.apply_push_results(prior, &rejected).unwrap();
    let selected = store
        .review_service_assignment(CUT, Some(&prior[1].mutation_id))
        .unwrap();
    assert_eq!(
        selected.work,
        crate::store::AssignmentWork::Conflict {
            id: prior[1].mutation_id.clone(),
            change: second,
        }
    );
}

fn seeded() -> Store {
    let mut s = Store::open_in_memory().unwrap();
    seed(&mut s);
    s
}

#[test]
fn appointment_notes_survive_restart_and_keep_the_cloud_note_on_conflict() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("notes.sqlite");
    let mut store = Store::open(&file).unwrap();
    seed(&mut store);
    store.set_meta("calendar_scope", ANA).unwrap();
    queue_appointment_notes(&mut store, EXISTING, "", "Offline draft", None).unwrap();
    drop(store);

    let mut store = Store::open(&file).unwrap();
    let before = store.appointment(EXISTING).unwrap().unwrap();
    let projected = effective_appointment(&store, EXISTING).unwrap().unwrap();
    assert_eq!(projected.notes.as_deref(), Some("Offline draft"));
    assert_eq!(projected.version, 4);
    assert_eq!(projected.starts_at, before.starts_at);
    queue_appointment_notes(
        &mut store,
        EXISTING,
        "Offline draft",
        "Continued offline draft",
        None,
    )
    .unwrap();
    let mut cloud = before;
    cloud.version += 1;
    cloud.notes = Some("Cloud note".into());
    store
        .apply_page(&[up(8, "appointment", EXISTING, json!(cloud))], 8)
        .unwrap();
    assert_eq!(
        effective_appointment(&store, EXISTING)
            .unwrap()
            .unwrap()
            .notes,
        cloud.notes
    );
    let sent = store.outbox(10).unwrap();
    let id = &sent[0].mutation_id;
    store
        .apply_push_results(
            &sent[..1],
            &[MutationResult::Rejected {
                mutation_id: id.clone(),
                reason: "conflict".into(),
                message: "Version changed".into(),
                replayed: false,
            }],
        )
        .unwrap();
    assert!(matches!(
        queue_appointment_notes(&mut store, EXISTING, "", "Offline draft", Some(id)),
        Err(crate::error::CoreError::AppointmentChanged)
    ));
    assert_eq!(
        store.conflict(id).unwrap().unwrap().payload["notes"],
        "Offline draft"
    );
    assert_eq!(
        store
            .conflict(&sent[1].mutation_id)
            .unwrap()
            .unwrap()
            .payload["notes"],
        "Continued offline draft"
    );
    queue_appointment_notes(
        &mut store,
        EXISTING,
        "Cloud note",
        "Offline draft",
        Some(id),
    )
    .unwrap();
    assert!(store.conflict(id).unwrap().is_none());
    let retry = store.outbox(10).unwrap().remove(0);
    assert_ne!(retry.mutation_id, *id);
    assert_eq!(retry.payload["version"], 4);

    store.set_meta("calendar_scope", BEA).unwrap();
    assert!(queue_appointment_notes(&mut store, EXISTING, "Offline draft", "", None).is_err());
    assert_eq!(store.outbox_len().unwrap(), 1);
}

fn seed(s: &mut Store) {
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
            "bufferMinutes": 15, "priceCents": 10000, "currency": "ARS", "active": true, "updatedAt": T0, "quoteHash": "a".repeat(64)}),
        ),
        up(
            5,
            "service",
            DRY,
            json!({"id": DRY, "name": "Blow dry", "description": null, "durationMinutes": 30,
            "bufferMinutes": 0, "priceCents": 5000, "currency": "ARS", "active": true, "updatedAt": T0, "quoteHash": "a".repeat(64)}),
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
fn team_week_resolves_local_shifts_absences_and_replica_permissions() {
    let mut store = seeded();
    store.set_meta("calendar_scope", "all").unwrap();
    store.set_meta("time_off_scope", "all").unwrap();
    let changes = [
        up(
            40,
            "staff",
            ANA,
            json!({"id": ANA, "displayName": "Ana", "active": true, "userId": null, "updatedAt": T0}),
        ),
        up(
            41,
            "working_hours",
            "tuesday",
            json!({"id": "tuesday", "staffId": ANA, "weekday": 2, "startTime": "09:00", "endTime": "17:00"}),
        ),
        up(
            42,
            "date_shift",
            "monday",
            json!({"id": "monday", "staffId": ANA, "date": "2026-03-09", "ranges": [{"startTime": "12:00", "endTime": "14:00"}], "version": 1, "updatedAt": T0}),
        ),
        up(
            43,
            "date_shift",
            "wednesday",
            json!({"id": "wednesday", "staffId": ANA, "date": "2026-03-11", "ranges": [], "version": 1, "updatedAt": T0}),
        ),
    ];
    store.apply_page(&changes, 43).unwrap();
    let start = at("2026-03-10T02:00:00Z");
    let end = at("2026-03-11T03:00:00Z");
    ops::create_time_off(&mut store, ANA, start, end, "Private reason").unwrap();
    let week = crate::team_shifts::team_week(&store, day("2026-03-12")).unwrap();
    assert_eq!(week.week, day("2026-03-09"));
    assert_eq!(week.members.len(), 2);
    let ana = &week.members[0];
    assert_eq!(ana.name, "Ana");
    assert!(ana.days[0].custom);
    assert_eq!(ana.days[0].ranges[0].start_time, "12:00");
    assert!(!ana.days[1].custom);
    assert_eq!(ana.days[1].ranges[0].start_time, "09:00");
    assert!(ana.days[2].custom && ana.days[2].ranges.is_empty());
    assert_eq!(ana.days[0].absences[0].end, at("2026-03-10T03:00:00Z"));
    assert!(ana.days[1].absences[0].full_day && ana.days[1].absences[0].pending);
    assert!(ana.days[2].absences.is_empty());

    store.set_meta("time_off_scope", ANA).unwrap();
    let own = crate::team_shifts::team_week(&store, week.week).unwrap();
    assert_eq!(
        own.members
            .iter()
            .map(|member| member.id.as_str())
            .collect::<Vec<_>>(),
        [ANA]
    );
    store.set_meta("calendar_scope", ANA).unwrap();
    store.set_meta("time_off_scope", "none").unwrap();
    assert_eq!(
        crate::team_shifts::team_week(&store, week.week)
            .unwrap()
            .members[0]
            .id,
        ANA
    );
    store.set_meta("calendar_scope", "none").unwrap();
    assert!(
        crate::team_shifts::team_week(&store, week.week)
            .unwrap()
            .members
            .is_empty()
    );
}

#[test]
fn offline_blocks_move_between_days_and_keep_existing_visits() {
    let mut store = seeded();
    let date = day("2026-03-09");
    let start = at("2026-03-09T15:00:00Z");
    let end = at("2026-03-09T16:00:00Z");
    let id = ops::create_time_off(&mut store, ANA, start, end, " Lunch ").unwrap();
    let view = calendar::day_view(&store, date).unwrap();
    let ana = column(&view, "Ana");
    let block = &ana.blocks[0];
    assert!(block.pending);
    assert_eq!(block.time_off.id, id);
    assert_eq!(block.time_off.reason.as_deref(), Some("Lunch"));
    assert_eq!(ana.items[0].appointment.id, EXISTING);
    assert!(
        calendar::effective_time_off(&store, end, end + chrono::Duration::hours(1))
            .unwrap()
            .is_empty()
    );
    let tomorrow = chrono::Duration::days(1);
    ops::update_time_off(
        &mut store,
        &block.time_off,
        start + tomorrow,
        end + tomorrow,
        "",
    )
    .unwrap();
    assert!(ops::delete_time_off(&mut store, &block.time_off).is_err());
    let view = calendar::day_view(&store, date).unwrap();
    let ana = column(&view, "Ana");
    assert!(ana.blocks.is_empty());
    assert_eq!(ana.items[0].appointment.status, AppointmentStatus::Booked);
    let view = calendar::day_view(&store, date.succ_opt().unwrap()).unwrap();
    let next = &column(&view, "Ana").blocks[0].time_off;
    assert_eq!(next.reason, None);
    ops::delete_time_off(&mut store, next).unwrap();
    assert!(
        column(&calendar::day_view(&store, view.date).unwrap(), "Ana")
            .blocks
            .is_empty()
    );
}

#[test]
fn accepted_time_off_keeps_the_slot_blocked_until_pull_and_a_delete_keeps_it_open() {
    let mut store = seeded();
    let start = at("2026-03-09T15:00:00Z");
    let end = at("2026-03-09T16:00:00Z");
    let id = ops::create_time_off(&mut store, ANA, start, end, "Lunch").unwrap();
    for (expected_kind, seq) in [("time_off.create", 9), ("time_off.delete", 11)] {
        let (generation, batch) = store.push_snapshot(100).unwrap();
        assert_eq!(batch.len(), 1);
        assert_eq!(batch[0].kind, expected_kind);
        store
            .apply_push_results_in(
                &batch,
                &[MutationResult::Applied {
                    mutation_id: batch[0].mutation_id.clone(),
                    applied_seq: Some(seq),
                    replayed: false,
                }],
                Some(&generation),
                Some(15),
            )
            .unwrap();
        assert!(store.push_snapshot(100).unwrap().1.is_empty());
        let blocks = effective_time_off(&store, start, end).unwrap();
        if expected_kind == "time_off.create" {
            assert_eq!(blocks.len(), 1);
            assert_eq!(blocks[0].time_off.id, id);
            assert!(blocks[0].pending);
            assert!(ops::delete_time_off(&mut store, &blocks[0].time_off).is_err());
            store
                .apply_page(&[up(8, "time_off", &id, json!(blocks[0].time_off))], 8)
                .unwrap();
            let canonical = effective_time_off(&store, start, end).unwrap();
            assert_eq!(canonical.len(), 1);
            assert!(!canonical[0].pending);
            ops::delete_time_off(&mut store, &canonical[0].time_off).unwrap();
        } else {
            assert!(blocks.is_empty());
        }
    }
    store
        .apply_page(
            &[RawChange {
                seq: 10,
                entity: "time_off".into(),
                id,
                op: "delete".into(),
                data: None,
            }],
            10,
        )
        .unwrap();
    assert!(effective_time_off(&store, start, end).unwrap().is_empty());
    assert_eq!(store.outbox_len().unwrap(), 0);
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
fn an_accepted_booking_and_its_new_client_survive_reopening_before_pull() {
    let directory = tempfile::tempdir().unwrap();
    let file = directory.path().join("replica.sqlite");
    let mut store = Store::open(&file).unwrap();
    seed(&mut store);
    let date = day("2026-03-10");
    let id = create_appointment_for_new_client(
        &mut store,
        new_appt("2026-03-10T13:00:00Z"),
        "New client",
        None,
    )
    .unwrap();
    let pending = day_view(&store, date).unwrap();
    let confirmed = column(&pending, "Bea").items[0].appointment.clone();
    let (generation, batch) = store.push_snapshot(100).unwrap();
    assert_eq!(batch.len(), 2);
    assert!(batch[1].to_wire().payload.get("_clientName").is_none());
    let results: Vec<_> = batch
        .iter()
        .zip([8, 9])
        .map(|(entry, seq)| MutationResult::Applied {
            mutation_id: entry.mutation_id.clone(),
            applied_seq: Some(seq),
            replayed: false,
        })
        .collect();
    store
        .apply_push_results_in(&batch, &results, Some(&generation), Some(15))
        .unwrap();
    drop(store);

    let mut store = Store::open(&file).unwrap();
    assert!(store.push_snapshot(100).unwrap().1.is_empty());
    let reopened = day_view(&store, date).unwrap();
    let items = &column(&reopened, "Bea").items;
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].appointment.id, id);
    assert_eq!(items[0].client_name, "New client");
    assert!(items[0].pending);
    store.set_meta("client_directory", "denied").unwrap();
    let booking_only = day_view(&store, date).unwrap();
    assert_eq!(
        column(&booking_only, "Bea").items[0].client_name,
        "New client"
    );
    assert!(
        known_clients(&store)
            .unwrap()
            .iter()
            .all(|(_, name)| name != "New client")
    );
    // Upgraded replicas can have a booking queued before its display name was stored.
    rusqlite::Connection::open(&file).unwrap().execute(
        "UPDATE outbox SET payload = json_remove(payload, '$._clientName') WHERE entity_id = ?1",
        [&id],
    ).unwrap();
    let legacy = day_view(&store, date).unwrap();
    assert_eq!(column(&legacy, "Bea").items[0].client_name, "New client");
    store.set_meta("client_directory", "allowed").unwrap();

    store.apply_page(&[up(8, "client", &confirmed.client_id, json!({
        "id": confirmed.client_id, "name": "New client", "createdAt": T0, "updatedAt": T0
    }))], 8).unwrap();
    let partial = day_view(&store, date).unwrap();
    assert_eq!(column(&partial, "Bea").items[0].client_name, "New client");
    assert!(column(&partial, "Bea").items[0].pending);
    store
        .apply_page(&[up(9, "appointment", &id, json!(confirmed))], 9)
        .unwrap();
    let synced = day_view(&store, date).unwrap();
    let items = &column(&synced, "Bea").items;
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].appointment.id, id);
    assert!(!items[0].pending);
    assert_eq!(store.outbox_len().unwrap(), 0);
}

#[test]
fn accepted_appointment_changes_follow_the_current_staff_scope_before_pull() {
    let mut store = seeded();
    store.set_meta("calendar_scope", "all").unwrap();
    let id = create_appointment(&mut store, new_appt("2026-03-10T13:00:00Z")).unwrap();
    for (expected_kind, seq) in [("appointment.create", 8), ("appointment.reschedule", 9)] {
        if expected_kind == "appointment.reschedule" {
            reschedule_appointment(&mut store, &id, None, Some(ANA)).unwrap();
        }
        let (generation, batch) = store.push_snapshot(100).unwrap();
        assert_eq!(batch.len(), 1);
        assert_eq!(batch[0].kind, expected_kind);
        store
            .apply_push_results_in(
                &batch,
                &[MutationResult::Applied {
                    mutation_id: batch[0].mutation_id.clone(),
                    applied_seq: Some(seq),
                    replayed: false,
                }],
                Some(&generation),
                Some(15),
            )
            .unwrap();
    }
    let generation = store.push_snapshot(100).unwrap().0;
    store
        .apply_visibility_scopes(Some(false), Some(ANA), &generation)
        .unwrap();
    let accepted = effective_appointment(&store, &id).unwrap().unwrap();
    assert_eq!(accepted.staff_id, ANA);
    assert_eq!(accepted.version, 2);
    store
        .apply_visibility_scopes(Some(false), Some(BEA), &generation)
        .unwrap();
    assert!(effective_appointment(&store, &id).unwrap().is_none());
    assert!(store.push_snapshot(100).unwrap().1.is_empty());
}

#[test]
fn an_early_authoritative_tombstone_retires_the_accepted_create() {
    let mut store = seeded();
    let id = create_appointment(&mut store, new_appt("2026-03-10T13:00:00Z")).unwrap();
    let (generation, batch) = store.push_snapshot(100).unwrap();
    store
        .apply_push_results_in(
            &batch,
            &[MutationResult::Applied {
                mutation_id: batch[0].mutation_id.clone(),
                applied_seq: Some(9),
                replayed: false,
            }],
            Some(&generation),
            Some(15),
        )
        .unwrap();
    assert!(effective_appointment(&store, &id).unwrap().is_some());
    store
        .apply_page(
            &[RawChange {
                seq: 8,
                entity: "appointment".into(),
                id: id.clone(),
                op: "delete".into(),
                data: None,
            }],
            8,
        )
        .unwrap();
    assert!(effective_appointment(&store, &id).unwrap().is_none());
    assert_eq!(store.outbox_len().unwrap(), 0);
}

#[test]
fn a_pulled_current_version_is_not_edited_twice_before_the_receipt_cursor() {
    let mut store = seeded();
    let moved_to = at("2026-03-09T17:00:00Z");
    reschedule_appointment(&mut store, EXISTING, Some(moved_to), None).unwrap();
    let (generation, batch) = store.push_snapshot(100).unwrap();
    store
        .apply_push_results_in(
            &batch,
            &[MutationResult::Applied {
                mutation_id: batch[0].mutation_id.clone(),
                applied_seq: Some(9),
                replayed: false,
            }],
            Some(&generation),
            Some(15),
        )
        .unwrap();
    let confirmed = effective_appointment(&store, EXISTING).unwrap().unwrap();
    assert_eq!((confirmed.starts_at, confirmed.version), (moved_to, 4));
    // An earlier log entry can already return the server's current appointment projection.
    store
        .apply_page(&[up(8, "appointment", EXISTING, json!(confirmed))], 8)
        .unwrap();
    assert_eq!(
        effective_appointment(&store, EXISTING)
            .unwrap()
            .unwrap()
            .version,
        4
    );
    cancel_appointment(&mut store, EXISTING).unwrap();
    let (_, sendable) = store.push_snapshot(100).unwrap();
    assert_eq!(sendable.len(), 1);
    assert_eq!(sendable[0].kind, "appointment.cancel");
    assert_eq!(sendable[0].payload["version"], 4);
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
fn pending_bookings_use_the_local_capacity_and_cancellation_releases_it() {
    let mut s = seeded();
    s.apply_page(
        &[up(
            8,
            "staff",
            BEA,
            json!({
                "id":BEA,"displayName":"Bea","active":true,"userId":null,
                "maxConcurrent":2,"updatedAt":T0
            }),
        )],
        8,
    )
    .unwrap();
    let booking = new_appt("2026-03-10T13:00:00Z");
    let first = create_appointment(&mut s, booking.clone()).unwrap();
    create_appointment(&mut s, booking.clone()).unwrap();
    assert!(matches!(
        create_appointment(&mut s, booking.clone()),
        Err(crate::error::CoreError::StaffCapacityExceeded)
    ));
    assert_eq!(s.outbox_len().unwrap(), 2);
    cancel_appointment(&mut s, &first).unwrap();
    create_appointment(&mut s, booking).unwrap();
    create_appointment(&mut s, new_appt("2026-03-10T14:30:00Z")).unwrap();
}

#[test]
fn the_replica_keeps_the_frozen_processing_gap_available() {
    let mut s = seeded();
    s.apply_page(&[up(8,"appointment",EXISTING,json!({
      "id":EXISTING,"staffId":ANA,"clientId":LUCIA,
      "startsAt":"2026-03-09T15:00:00Z","endsAt":"2026-03-09T16:00:00Z",
      "status":"booked","version":3,"notes":null,"services":[],"createdAt":T0,"updatedAt":T0,
      "workWindows":[{"offsetMinutes":0,"endOffsetMinutes":10},{"offsetMinutes":40,"endOffsetMinutes":60}]
    }))],8).unwrap();
    let mut booking = new_appt("2026-03-09T15:00:00Z");
    booking.staff_id = ANA.into();
    booking.service_ids = vec![DRY.into()];
    assert!(matches!(
        create_appointment(&mut s, booking.clone()),
        Err(crate::error::CoreError::StaffCapacityExceeded)
    ));
    booking.starts_at = at("2026-03-09T15:10:00Z");
    create_appointment(&mut s, booking).unwrap();
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
fn a_personal_calendar_rejects_reassigning_an_appointment_outside_its_scope() {
    let mut store = seeded();
    store.set_meta("calendar_scope", ANA).unwrap();

    assert!(matches!(
        reschedule_appointment(&mut store, EXISTING, None, Some(BEA)),
        Err(crate::error::CoreError::AppointmentScopeDenied)
    ));
    assert!(store.outbox(10).unwrap().is_empty());

    let start = at("2026-03-09T17:00:00Z");
    store.set_meta("time_off_scope", "none").unwrap();
    assert!(matches!(
        reschedule_appointment(&mut store, EXISTING, Some(start), None),
        Err(crate::error::CoreError::AppointmentScopeDenied)
    ));

    store.set_meta("viewer_edit_calendar", "0").unwrap();
    assert!(matches!(
        reschedule_appointment(&mut store, EXISTING, Some(start), None),
        Err(crate::error::CoreError::AppointmentScopeDenied)
    ));
    assert!(store.outbox(10).unwrap().is_empty());

    store.set_meta("viewer_edit_calendar", "1").unwrap();
    reschedule_appointment(&mut store, EXISTING, Some(start), None).unwrap();
    assert_eq!(
        effective_appointment(&store, EXISTING)
            .unwrap()
            .unwrap()
            .starts_at,
        start
    );
}

#[test]
fn appointment_creation_cancellation_and_outcomes_respect_current_calendar_access() {
    use crate::error::CoreError;

    let mut store = seeded();
    let now = at("2026-03-09T16:00:00Z");
    let mut booking = new_appt("2026-03-09T18:00:00Z");
    booking.staff_id = ANA.into();
    store.set_meta("viewer_edit_calendar", "0").unwrap();

    assert!(matches!(
        create_appointment(&mut store, booking.clone()),
        Err(CoreError::AppointmentScopeDenied)
    ));
    assert!(matches!(
        cancel_appointment(&mut store, EXISTING),
        Err(CoreError::AppointmentScopeDenied)
    ));
    assert!(matches!(
        set_appointment_status(&mut store, EXISTING, AppointmentStatus::Completed, now),
        Err(CoreError::AppointmentScopeDenied)
    ));
    assert!(store.outbox(10).unwrap().is_empty());

    store.set_meta("viewer_edit_calendar", "1").unwrap();
    store.set_meta("calendar_scope", BEA).unwrap();
    assert!(matches!(
        create_appointment(&mut store, booking),
        Err(CoreError::AppointmentScopeDenied)
    ));
    assert!(matches!(
        cancel_appointment(&mut store, EXISTING),
        Err(CoreError::AppointmentScopeDenied)
    ));
    assert!(store.outbox(10).unwrap().is_empty());
}

#[test]
fn open_booking_review_rechecks_access_before_dispatch() {
    use crate::booking::{BookingAttempt, BookingTerms};
    use crate::error::CoreError;
    use crate::intake::IntakeSelection;

    let mut store = seeded();
    let terms = BookingTerms::prepare(&store, new_appt("2026-03-09T18:00:00Z"), None).unwrap();
    let reviewed = terms.reviewed(
        "intake".into(),
        IntakeSelection {
            saved: Default::default(),
            inline: Default::default(),
        },
    );
    let packet = BookingAttempt::Single(reviewed);

    store.set_meta("viewer_edit_calendar", "0").unwrap();
    assert!(matches!(
        packet.check_before_dispatch(&mut store),
        Err(CoreError::AppointmentScopeDenied)
    ));

    store.set_meta("viewer_edit_calendar", "1").unwrap();
    packet.check_before_dispatch(&mut store).unwrap();
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
fn a_rejected_move_preserves_dependent_appointment_edits_for_review_instead_of_sending_them() {
    let mut s = seeded();
    reschedule_appointment(&mut s, EXISTING, Some(at("2026-03-09T17:00:00Z")), None).unwrap();
    let optimistic = effective_appointment(&s, EXISTING).unwrap().unwrap();
    let review = ReviewedAppointment::from(&optimistic);
    cancel_appointment(&mut s, EXISTING).unwrap();
    let (_, batch) = s.push_snapshot(100).unwrap();
    assert_eq!(batch.len(), 1);
    let result = MutationResult::Rejected {
        mutation_id: batch[0].mutation_id.clone(),
        reason: "conflict".into(),
        message: "Cloud appointment changed".into(),
        replayed: false,
    };
    assert_eq!(s.apply_push_results(&batch, &[result]).unwrap().rejected, 2);
    assert!(s.push_snapshot(100).unwrap().1.is_empty());
    let conflicts = s.conflicts().unwrap();
    assert_eq!(conflicts.len(), 2);
    assert!(
        conflicts
            .iter()
            .any(|edit| edit.kind == "appointment.cancel" && edit.payload["version"] == 4)
    );

    let mut cloud = s.appointment(EXISTING).unwrap().unwrap();
    cloud.version = optimistic.version;
    cloud.starts_at = at("2026-03-09T18:00:00Z");
    cloud.ends_at = at("2026-03-09T19:00:00Z");
    s.apply_page(&[up(20, "appointment", EXISTING, json!(cloud))], 20)
        .unwrap();
    assert!(matches!(
        queue_reviewed_appointment_edit(&mut s, EXISTING, &review, AppointmentEdit::Cancel, None),
        Err(crate::error::CoreError::AppointmentChanged)
    ));
    assert!(s.outbox(10).unwrap().is_empty());
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
fn recording_an_outcome_offline_updates_the_calendar_and_preserves_the_version() {
    for status in [AppointmentStatus::Completed, AppointmentStatus::NoShow] {
        let mut store = seeded();
        set_appointment_status(&mut store, EXISTING, status, at("2026-03-10T12:00:00Z")).unwrap();
        let current = effective_appointment(&store, EXISTING).unwrap().unwrap();
        assert_eq!(current.status, status);
        assert_eq!(current.version, 4);
        let jobs = store.outbox(10).unwrap();
        assert_eq!(jobs[0].kind, "appointment.set_status");
        assert_eq!(jobs[0].payload["version"], json!(3));
        assert_eq!(jobs[0].payload["status"], json!(status.as_str()));
        assert!(column(&day_view(&store, day("2026-03-09")).unwrap(), "Ana").items[0].pending);
    }
}

#[test]
fn all_calendar_editors_can_correct_attendance_in_both_directions() {
    let mut store = seeded();
    store.set_meta("calendar_scope", "all").unwrap();
    let now = at("2026-03-10T12:00:00Z");

    for status in [
        AppointmentStatus::NoShow,
        AppointmentStatus::Completed,
        AppointmentStatus::NoShow,
    ] {
        set_appointment_status(&mut store, EXISTING, status, now).unwrap();
        assert_eq!(
            effective_appointment(&store, EXISTING)
                .unwrap()
                .unwrap()
                .status,
            status
        );
    }
    let outbox = store.outbox(10).unwrap();
    assert_eq!(
        outbox
            .iter()
            .map(|entry| &entry.payload["version"])
            .collect::<Vec<_>>(),
        [&json!(3), &json!(4), &json!(5)]
    );
    assert!(cancel_appointment(&mut store, EXISTING).is_err());
    assert!(set_appointment_status(&mut store, EXISTING, AppointmentStatus::NoShow, now).is_err());
}

#[test]
fn outcomes_cannot_close_future_or_already_closed_appointments() {
    let mut store = seeded();
    assert!(
        set_appointment_status(
            &mut store,
            EXISTING,
            AppointmentStatus::Completed,
            at("2026-03-08T12:00:00Z")
        )
        .is_err()
    );
    assert!(
        set_appointment_status(
            &mut store,
            EXISTING,
            AppointmentStatus::Cancelled,
            at("2026-03-10T12:00:00Z")
        )
        .is_err()
    );
    assert!(store.outbox(10).unwrap().is_empty());
    set_appointment_status(
        &mut store,
        EXISTING,
        AppointmentStatus::Completed,
        at("2026-03-10T12:00:00Z"),
    )
    .unwrap();
    assert!(
        set_appointment_status(
            &mut store,
            EXISTING,
            AppointmentStatus::NoShow,
            at("2026-03-10T12:00:00Z")
        )
        .is_err()
    );
    assert_eq!(store.outbox(10).unwrap().len(), 1);
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

#[test]
fn merged_aliases_leave_the_picker_without_erasing_history_or_queued_proposals() {
    let mut s = seeded();
    create_appointment(&mut s, new_appt("2026-03-10T13:00:00Z")).unwrap();
    let pending = s.outbox(10).unwrap();
    let target = "01a1d81e-0000-7000-8000-0000000000c2";
    s.apply_page(&[
        up(8, "client", target, json!({"id": target, "name": "Surviving Lucia", "phone": null, "email": null, "notes": null, "createdAt": T0, "updatedAt": T0})),
        up(9, "client", LUCIA, json!({"id": LUCIA, "name": "Lucia", "phone": null, "email": null, "notes": null, "mergedIntoId": target, "createdAt": T0, "updatedAt": T0})),
    ], 9).unwrap();
    let choices = known_clients(&s).unwrap();
    assert!(!choices.iter().any(|(id, _)| id == LUCIA));
    assert!(choices.iter().any(|(id, _)| id == target));
    assert_eq!(s.cursor().unwrap(), 9);
    assert_eq!(s.outbox(10).unwrap()[0].payload, pending[0].payload);
    assert_eq!(
        column(&day_view(&s, day("2026-03-09")).unwrap(), "Ana").items[0].client_name,
        "Lucia"
    );
    assert!(create_appointment(&mut s, new_appt("2026-03-11T13:00:00Z")).is_err());
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

#[test]
fn free_text_beyond_the_server_limits_is_rejected_before_it_is_queued() {
    let mut s = seeded();
    let before = s.outbox_len().unwrap();

    // The API contract caps names at 200, phones at 32 and notes at 2000 UTF-16 units.
    assert!(create_client(&mut s, &"n".repeat(200), None).is_ok());
    assert!(create_client(&mut s, &"n".repeat(201), None).is_err());
    assert!(create_client(&mut s, "Ana", Some(&"1".repeat(33))).is_err());

    let booking = |notes: String| NewAppointment {
        staff_id: ANA.into(),
        service_ids: vec![CUT.into()],
        starts_at: at("2026-03-10T13:00:00Z"),
        client_id: LUCIA.into(),
        notes: Some(notes),
        override_notice: false,
    };
    assert!(create_appointment(&mut s, booking("n".repeat(2000))).is_ok());
    assert!(create_appointment(&mut s, booking("n".repeat(2001))).is_err());
    // Counted the way the server counts (UTF-16 code units): an emoji is two.
    assert!(create_appointment(&mut s, booking("😀".repeat(1001))).is_err());

    // Only the two valid mutations were queued (the client of the first assertion and the booking).
    assert_eq!(s.outbox_len().unwrap(), before + 2);
}

#[test]
fn processing_and_capacity_survive_the_native_replica_round_trip() {
    let mut s = seeded();
    s.apply_page(&[
        up(8,"staff",BEA,json!({"id":BEA,"displayName":"Bea","active":true,"userId":null,"maxConcurrent":2,"updatedAt":T0})),
        up(9,"service",CUT,json!({"id":CUT,"name":"Haircut","description":null,"durationMinutes":90,"bufferMinutes":15,"priceCents":10000,"currency":"ARS","active":true,"updatedAt":T0,"processing":{"startsAfterMinutes":30,"minutes":30},"quoteHash":"a".repeat(64)}))
    ],9).unwrap();
    let member = s
        .staff()
        .unwrap()
        .into_iter()
        .find(|row| row.id == BEA)
        .unwrap();
    assert_eq!(serde_json::to_value(member).unwrap()["maxConcurrent"], 2);
    let treatment = s
        .services()
        .unwrap()
        .into_iter()
        .find(|row| row.id == CUT)
        .unwrap();
    assert_eq!(
        serde_json::to_value(treatment).unwrap()["processing"],
        json!({"startsAfterMinutes":30,"minutes":30})
    );
}

#[test]
fn a_pending_native_booking_freezes_reviewed_work_and_prices_but_never_sends_local_snapshot_fields()
{
    let mut s = seeded();
    s.apply_page(&[
        up(8,"service",CUT,json!({"id":CUT,"name":"Haircut","description":null,"durationMinutes":90,"bufferMinutes":15,"priceCents":10000,"currency":"ARS","active":true,"updatedAt":T0,"processing":{"startsAfterMinutes":30,"minutes":30},"quoteHash":"a".repeat(64)})),
        up(9,"service",DRY,json!({"id":DRY,"name":"Blow dry","description":null,"durationMinutes":30,"bufferMinutes":0,"priceCents":5000,"currency":"ARS","active":true,"updatedAt":T0,"quoteHash":"b".repeat(64)}))
    ],9).unwrap();
    let id = create_appointment(&mut s, new_appt("2026-03-09T12:00:00Z")).unwrap();
    let entry = s.outbox(10).unwrap().remove(0);
    assert_eq!(
        entry.to_wire().payload["serviceQuotes"][CUT],
        "a".repeat(64)
    );
    assert!(entry.to_wire().payload.get("_reviewedServices").is_none());
    s.apply_page(&[up(10,"service",CUT,json!({"id":CUT,"name":"Haircut changed","description":null,"durationMinutes":120,"bufferMinutes":15,"priceCents":99000,"currency":"ARS","active":true,"updatedAt":T0,"quoteHash":"c".repeat(64)}))],10).unwrap();
    let proposed = effective_appointment(&s, &id).unwrap().unwrap();
    assert_eq!(proposed.services[0].name, "Haircut");
    assert_eq!(proposed.services[0].duration_minutes, 90);
    assert_eq!(proposed.services[0].price_cents, 10000);
    assert_eq!(
        serde_json::to_value(&proposed.services[0]).unwrap()["processing"],
        json!({"startsAfterMinutes":30,"minutes":30})
    );
}

#[test]
fn an_old_unquoted_catalog_remains_readable_but_cannot_create_an_unfenced_booking() {
    let mut s = seeded();
    s.apply_page(&[up(8,"service",CUT,json!({"id":CUT,"name":"Legacy haircut","description":null,"durationMinutes":45,"bufferMinutes":15,"priceCents":10000,"currency":"ARS","active":true,"updatedAt":T0}))],8).unwrap();
    assert!(
        s.services()
            .unwrap()
            .iter()
            .any(|row| row.name == "Legacy haircut")
    );
    let error = create_appointment(&mut s, new_appt("2026-03-09T12:00:00Z")).unwrap_err();
    assert!(error.to_string().contains("Refresh the service catalogue"));
    assert_eq!(s.outbox_len().unwrap(), 0);
}

#[test]
fn changed_reviewed_terms_cannot_be_accepted_by_merely_retrying_at_another_time() {
    let mut s = seeded();
    let id = create_appointment(&mut s, new_appt("2026-03-09T12:00:00Z")).unwrap();
    let entry = s.outbox(10).unwrap().remove(0);
    s.apply_push_results(
        std::slice::from_ref(&entry),
        &[MutationResult::Rejected {
            mutation_id: entry.mutation_id.clone(),
            reason: "conflict".into(),
            message: "Reviewed treatment terms changed".into(),
            replayed: false,
        }],
    )
    .unwrap();
    assert!(
        resolve_conflict(
            &mut s,
            &entry.mutation_id,
            Resolution::Reschedule {
                starts_at: at("2026-03-10T12:00:00Z"),
                staff_id: None
            }
        )
        .is_err()
    );
    assert_eq!(s.outbox_len().unwrap(), 0);
    assert_eq!(s.conflicts().unwrap().len(), 1);
    resolve_conflict(&mut s, &entry.mutation_id, Resolution::Cancel).unwrap();
    assert!(effective_appointment(&s, &id).unwrap().is_none());
}

#[test]
fn offline_peak_quote_matches_the_api_encoding_and_fences_the_pending_booking() {
    let mut replica = seeded();
    replica
        .apply_page(
            &[up(
                8,
                "service",
                CUT,
                json!({
                    "id": CUT, "name": "Haircut", "description": null, "durationMinutes": 40,
                    "bufferMinutes": 5, "priceCents": 10000, "currency": "ARS", "active": true,
                    "updatedAt": T0, "quoteHash": "a".repeat(64)
                }),
            )],
            8,
        )
        .unwrap();
    let snapshot = crate::booking::PeakPriceSnapshot {
        version: 11,
        timezone: "America/Argentina/Buenos_Aires".into(),
        rules: vec![crate::booking::PeakPriceRule {
            increase_basis_points: 1500,
            service_ids: vec![CUT.into()],
            ..Default::default()
        }],
    };
    replica
        .set_meta(
            "peak_price_snapshot",
            &serde_json::to_string(&snapshot).unwrap(),
        )
        .unwrap();
    let new = || NewAppointment {
        service_ids: vec![CUT.into()],
        ..new_appt("2026-03-09T12:00:00Z")
    };
    let services = replica.services().unwrap();
    let quote = snapshot
        .quote(
            new().starts_at,
            services.iter().filter(|service| service.id == CUT),
        )
        .unwrap();
    let approved = "008d08cb267034e5fa2de671a6c8848a9ff1ca9ad6411c3044aeb91b411cea96";
    assert_eq!(quote.review.as_deref(), Some(approved));
    assert_eq!(quote.services[0].price_cents, 11500);
    assert!(matches!(
        create_appointment(&mut replica, new()),
        Err(crate::error::CoreError::PeakPriceReviewChanged)
    ));
    assert_eq!(replica.outbox_len().unwrap(), 0);
    let id = create_appointment_reviewed(&mut replica, new(), Some(approved)).unwrap();
    let queued = replica.outbox(10).unwrap().remove(0);
    assert_eq!(queued.to_wire().payload["peakPriceReview"], approved);
    let row = effective_appointment(&replica, &id).unwrap().unwrap();
    assert_eq!(row.services[0].price_cents, 11500);
}
