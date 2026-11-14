use serde_json::{Value, json};

use super::*;

pub fn staff_change(seq: i64, id: &str, name: &str) -> RawChange {
    RawChange {
        seq,
        entity: "staff".into(),
        id: id.into(),
        op: "upsert".into(),
        data: Some(json!({"id": id, "displayName": name, "active": true, "userId": null,
            "updatedAt": "2026-03-01T10:00:00.000Z"})),
    }
}

pub fn appt_json(id: &str, staff: &str, starts: &str, ends: &str, version: i64) -> Value {
    json!({"id": id, "staffId": staff, "clientId": "c1", "startsAt": starts, "endsAt": ends,
        "status": "booked", "notes": null, "version": version,
        "services": [{"serviceId": "s1", "name": "Haircut", "durationMinutes": 45,
            "bufferMinutes": 15, "priceCents": 10000, "currency": "ARS"}],
        "createdAt": "2026-03-01T10:00:00.000Z", "updatedAt": "2026-03-01T10:00:00.000Z"})
}

pub fn appt_change(seq: i64, id: &str, version: i64) -> RawChange {
    RawChange {
        seq,
        entity: "appointment".into(),
        id: id.into(),
        op: "upsert".into(),
        data: Some(appt_json(id, "st1", "2026-03-09T12:00:00.000Z", "2026-03-09T13:00:00.000Z", version)),
    }
}

pub fn tombstone(seq: i64, entity: &str, id: &str) -> RawChange {
    RawChange { seq, entity: entity.into(), id: id.into(), op: "delete".into(), data: None }
}

const A1: &str = "01a1d81e-0000-7000-8000-0000000000a1";
const A2: &str = "01a1d81e-0000-7000-8000-0000000000a2";

#[test]
fn migrations_run_once_and_survive_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("replica.db");
    {
        let mut s = Store::open(&path).unwrap();
        assert_eq!(s.schema_version().unwrap(), 1);
        s.apply_page(&[staff_change(3, "st1", "Ana")], 3).unwrap();
    }
    let s = Store::open(&path).unwrap();
    assert_eq!(s.schema_version().unwrap(), 1);
    assert_eq!(s.staff().unwrap().len(), 1);
}

#[test]
fn device_id_is_generated_once_and_stable() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("replica.db");
    let first = Store::open(&path).unwrap().device_id().unwrap();
    assert!(!first.is_empty() && first.len() <= 100);
    assert_eq!(Store::open(&path).unwrap().device_id().unwrap(), first);
}

#[test]
fn cursor_is_persisted_with_the_page_and_never_decreases() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("replica.db");
    {
        let mut s = Store::open(&path).unwrap();
        assert_eq!(s.cursor().unwrap(), 0);
        s.apply_page(&[appt_change(5, A1, 1)], 7).unwrap();
        s.apply_page(&[], 4).unwrap();
        assert_eq!(s.cursor().unwrap(), 7);
    }
    assert_eq!(Store::open(&path).unwrap().cursor().unwrap(), 7);
}

#[test]
fn a_page_with_an_invalid_row_rolls_back_including_the_cursor() {
    let mut s = Store::open_in_memory().unwrap();
    let bad = RawChange {
        seq: 2,
        entity: "appointment".into(),
        id: A2.into(),
        op: "upsert".into(),
        data: Some(json!({"id": A2})),
    };
    assert!(s.apply_page(&[appt_change(1, A1, 1), bad], 2).is_err());
    assert_eq!(s.cursor().unwrap(), 0);
    assert!(s.appointment(A1).unwrap().is_none());
}

#[test]
fn upserts_are_idempotent_and_keep_the_latest_state() {
    let mut s = Store::open_in_memory().unwrap();
    s.apply_page(&[appt_change(1, A1, 1)], 1).unwrap();
    s.apply_page(&[appt_change(1, A1, 1), appt_change(2, A1, 2)], 2).unwrap();
    assert_eq!(s.appointment(A1).unwrap().unwrap().version, 2);
    assert_eq!(s.appointments_between(0, i64::MAX).unwrap().len(), 1);
}

#[test]
fn tombstones_delete_rows_and_are_a_noop_when_absent() {
    let mut s = Store::open_in_memory().unwrap();
    s.apply_page(&[appt_change(1, A1, 1), staff_change(2, "st1", "Ana")], 2).unwrap();
    s.apply_page(&[tombstone(3, "appointment", A1), tombstone(4, "staff", "st1")], 4).unwrap();
    s.apply_page(&[tombstone(5, "appointment", A1), tombstone(6, "time_off", "zzz")], 6).unwrap();
    assert!(s.appointment(A1).unwrap().is_none());
    assert!(s.staff().unwrap().is_empty());
    assert_eq!(s.cursor().unwrap(), 6);
}

#[test]
fn unknown_entities_are_skipped_but_the_cursor_advances() {
    let mut s = Store::open_in_memory().unwrap();
    let c = RawChange { seq: 9, entity: "loyalty_card".into(), id: "x".into(), op: "upsert".into(), data: Some(json!({})) };
    s.apply_page(&[c], 9).unwrap();
    assert_eq!(s.cursor().unwrap(), 9);
}

#[test]
fn appointments_between_returns_only_overlapping_rows() {
    let mut s = Store::open_in_memory().unwrap();
    s.apply_page(&[appt_change(1, A1, 1)], 1).unwrap();
    let t = |iso: &str| chrono::DateTime::parse_from_rfc3339(iso).unwrap().timestamp_millis();
    assert_eq!(s.appointments_between(t("2026-03-09T12:30:00Z"), t("2026-03-09T14:00:00Z")).unwrap().len(), 1);
    assert!(s.appointments_between(t("2026-03-09T13:00:00Z"), t("2026-03-09T14:00:00Z")).unwrap().is_empty());
    assert!(s.appointments_between(t("2026-03-09T00:00:00Z"), t("2026-03-09T12:00:00Z")).unwrap().is_empty());
}

#[test]
fn outbox_keeps_creation_order_and_uuidv7_mutation_ids() {
    let mut s = Store::open_in_memory().unwrap();
    let a = s.enqueue("appointment.create", A1, json!({"id": A1})).unwrap();
    let b = s.enqueue("appointment.cancel", A1, json!({"id": A1, "version": 2})).unwrap();
    let c = s.enqueue("client.create", "c9", json!({"id": "c9"})).unwrap();
    assert!(a.seq < b.seq && b.seq < c.seq);
    for e in [&a, &b, &c] {
        let u = uuid::Uuid::parse_str(&e.mutation_id).unwrap();
        assert_eq!(u.get_version_num(), 7);
    }
    let q = s.outbox(2).unwrap();
    assert_eq!(q.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), ["appointment.create", "appointment.cancel"]);
    assert_eq!(s.outbox_len().unwrap(), 3);
}

#[test]
fn outbox_survives_reopen_with_a_stable_created_at() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("replica.db");
    let e = Store::open(&path).unwrap().enqueue("appointment.cancel", A1, json!({"id": A1, "version": 1})).unwrap();
    let again = Store::open(&path).unwrap().outbox(10).unwrap();
    assert_eq!(again, vec![e]);
}

fn applied(id: &str) -> MutationResult {
    MutationResult::Applied { mutation_id: id.into(), applied_seq: Some(1), replayed: false }
}

#[test]
fn applied_results_leave_the_outbox() {
    let mut s = Store::open_in_memory().unwrap();
    let a = s.enqueue("client.create", "c1", json!({"id": "c1"})).unwrap();
    let r = s.apply_push_results(std::slice::from_ref(&a), &[applied(&a.mutation_id)]).unwrap();
    assert_eq!(r, PushApplied { applied: 1, rejected: 0, retry_pending: false });
    assert_eq!(s.outbox_len().unwrap(), 0);
}

#[test]
fn rejected_results_leave_the_outbox_and_become_conflicts() {
    let mut s = Store::open_in_memory().unwrap();
    let a = s.enqueue("appointment.create", A1, json!({"id": A1})).unwrap();
    let rej = MutationResult::Rejected {
        mutation_id: a.mutation_id.clone(),
        reason: "slot_taken".into(),
        message: "The selected time slot is no longer available".into(),
        replayed: false,
    };
    let r = s.apply_push_results(std::slice::from_ref(&a), &[rej]).unwrap();
    assert_eq!(r.rejected, 1);
    assert_eq!(s.outbox_len().unwrap(), 0);
    let conflicts = s.conflicts().unwrap();
    assert_eq!(conflicts.len(), 1);
    assert_eq!(conflicts[0].reason, "slot_taken");
    assert_eq!(conflicts[0].entity_id, A1);
    assert_eq!(conflicts[0].payload, json!({"id": A1}));
}

#[test]
fn a_retry_result_keeps_it_and_everything_after_it_queued() {
    let mut s = Store::open_in_memory().unwrap();
    let a = s.enqueue("client.create", "c1", json!({"id": "c1"})).unwrap();
    let b = s.enqueue("client.create", "c2", json!({"id": "c2"})).unwrap();
    let c = s.enqueue("client.create", "c3", json!({"id": "c3"})).unwrap();
    let sent = vec![a.clone(), b.clone(), c.clone()];
    let results = vec![
        applied(&a.mutation_id),
        MutationResult::Retry { mutation_id: b.mutation_id.clone(), message: "busy".into() },
        applied(&c.mutation_id), // must be ignored: it is after the retry
    ];
    let r = s.apply_push_results(&sent, &results).unwrap();
    assert_eq!(r, PushApplied { applied: 1, rejected: 0, retry_pending: true });
    let left: Vec<_> = s.outbox(10).unwrap().into_iter().map(|e| e.mutation_id).collect();
    assert_eq!(left, vec![b.mutation_id, c.mutation_id]);
}

#[test]
fn results_out_of_order_or_short_are_a_protocol_error_and_change_nothing() {
    let mut s = Store::open_in_memory().unwrap();
    let a = s.enqueue("client.create", "c1", json!({"id": "c1"})).unwrap();
    let b = s.enqueue("client.create", "c2", json!({"id": "c2"})).unwrap();
    let sent = vec![a.clone(), b.clone()];
    assert!(s.apply_push_results(&sent, &[applied(&b.mutation_id), applied(&a.mutation_id)]).is_err());
    assert!(s.apply_push_results(&sent, &[applied(&a.mutation_id)]).is_err());
    assert_eq!(s.outbox_len().unwrap(), 2);
}

#[test]
fn later_rejections_for_an_entity_with_an_open_conflict_do_not_pile_up() {
    let mut s = Store::open_in_memory().unwrap();
    let create = s.enqueue("appointment.create", A1, json!({"id": A1})).unwrap();
    let cancel = s.enqueue("appointment.cancel", A1, json!({"id": A1, "version": 2})).unwrap();
    let rej = |e: &OutboxEntry, reason: &str| MutationResult::Rejected {
        mutation_id: e.mutation_id.clone(),
        reason: reason.into(),
        message: "m".into(),
        replayed: false,
    };
    let sent = vec![create.clone(), cancel.clone()];
    s.apply_push_results(&sent, &[rej(&create, "slot_taken"), rej(&cancel, "not_found")]).unwrap();
    let c = s.conflicts().unwrap();
    assert_eq!(c.len(), 1);
    assert_eq!(c[0].reason, "slot_taken");
}

#[test]
fn resolved_conflicts_disappear_from_the_open_list() {
    let mut s = Store::open_in_memory().unwrap();
    let a = s.enqueue("appointment.create", A1, json!({"id": A1})).unwrap();
    let rej = MutationResult::Rejected { mutation_id: a.mutation_id.clone(), reason: "slot_taken".into(), message: "m".into(), replayed: false };
    s.apply_push_results(std::slice::from_ref(&a), &[rej]).unwrap();
    s.resolve_conflict(&a.mutation_id, "dismissed").unwrap();
    assert!(s.conflicts().unwrap().is_empty());
}

#[test]
fn failures_are_counted_on_the_queued_mutation() {
    let mut s = Store::open_in_memory().unwrap();
    let a = s.enqueue("client.create", "c1", json!({"id": "c1"})).unwrap();
    s.record_failure(std::slice::from_ref(&a.mutation_id), "connection refused").unwrap();
    let e = &s.outbox(1).unwrap()[0];
    assert_eq!(e.attempts, 1);
    assert_eq!(e.last_error.as_deref(), Some("connection refused"));
}

#[test]
fn resetting_the_replica_drops_the_mirror_and_cursor_but_keeps_the_outbox() {
    let mut s = Store::open_in_memory().unwrap();
    s.apply_page(&[appt_change(1, A1, 1)], 40).unwrap();
    s.enqueue("client.create", "c1", json!({"id": "c1"})).unwrap();
    let dev = s.device_id().unwrap();
    s.reset_replica().unwrap();
    assert_eq!(s.cursor().unwrap(), 0);
    assert!(s.appointment(A1).unwrap().is_none());
    assert_eq!(s.outbox_len().unwrap(), 1);
    assert_eq!(s.device_id().unwrap(), dev);
}
