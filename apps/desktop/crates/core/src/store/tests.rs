use serde_json::{Value, json};

use super::*;

#[test]
fn reviewed_commission_payout_survives_restart_and_clears_only_the_acknowledged_request() {
    use crate::reports::commissions::CommissionPayoutReview;

    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("replica.sqlite");
    let saved = SavedCommissionPayout {
        staff_id: uuid::Uuid::now_v7(),
        review: CommissionPayoutReview {
            actor_user_id: "manager".into(),
            generation: INITIAL_GENERATION.into(),
            amount_cents: 1200,
            reference: "External payment reference".into(),
            idempotency_key: uuid::Uuid::now_v7(),
        },
    };
    let mut another = saved.clone();
    another.review.idempotency_key = uuid::Uuid::now_v7();
    assert!(
        Store::open(&path)
            .unwrap()
            .reserve_commission_payout(&saved)
            .unwrap()
    );
    let store = Store::open(&path).unwrap();
    assert!(!store.reserve_commission_payout(&another).unwrap());
    assert!(
        store
            .pending_commission_payout(saved.staff_id, "other-user")
            .unwrap()
            .is_none()
    );
    store.clear_commission_payout(&another).unwrap();
    assert_eq!(
        store
            .pending_commission_payout(saved.staff_id, "manager")
            .unwrap(),
        Some(saved.clone())
    );
    let rebound = store
        .rebind_commission_payout(&saved, "restored")
        .unwrap()
        .unwrap();
    assert_eq!(rebound.review.idempotency_key, saved.review.idempotency_key);
    assert_eq!(rebound.review.amount_cents, saved.review.amount_cents);
    assert_eq!(rebound.review.reference, saved.review.reference);
    assert!(
        store
            .rebind_commission_payout(&saved, "another")
            .unwrap()
            .is_none()
    );
    store.clear_commission_payout(&saved).unwrap();
    assert_eq!(
        store
            .pending_commission_payout(saved.staff_id, "manager")
            .unwrap(),
        Some(rebound.clone())
    );
    store.clear_commission_payout(&rebound).unwrap();
    assert!(
        store
            .pending_commission_payout(saved.staff_id, "manager")
            .unwrap()
            .is_none()
    );
}

#[test]
fn saved_salon_settings_survive_restart_and_review_after_a_restore() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("replica.sqlite");
    let reviewed: ReviewedSalonConfiguration = serde_json::from_value(json!({
        "generation": INITIAL_GENERATION, "revision": "2026-11-21T00:00:00Z",
        "name": "Studio", "timezone": "Europe/Madrid", "slotGranularityMinutes": 15,
        "minNoticeMinutes": 30, "maxDaysAhead": 60, "onlineBookingEnabled": true,
        "reminderFirstLeadMinutes": 1440, "reminderSecondLeadMinutes": 120
    }))
    .unwrap();
    let mut draft = reviewed.settings.clone();
    draft.online_booking_enabled = false;
    let mut store = Store::open(&path).unwrap();
    store.cache_salon_configuration(&reviewed).unwrap();
    assert!(
        store
            .queue_salon_configuration(&reviewed, &draft, None)
            .unwrap()
    );
    assert!(
        store
            .queue_salon_configuration(&reviewed, &draft, None)
            .is_err()
    );
    drop(store);

    let mut store = Store::open(&path).unwrap();
    assert_eq!(
        store.cached_salon_configuration().unwrap(),
        Some(reviewed.clone())
    );
    assert!(matches!(
        store.salon_configuration_work().unwrap(),
        SalonConfigurationWork::Pending(Some(_))
    ));
    let original = store.outbox(1).unwrap().pop().unwrap();
    assert_eq!(
        original.payload["changes"],
        json!({"onlineBookingEnabled": false})
    );
    store
        .switch_replica_generation(INITIAL_GENERATION, "restored")
        .unwrap();
    assert!(store.cached_salon_configuration().unwrap().is_none());
    assert!(
        store
            .queue_salon_configuration(&reviewed, &draft, None)
            .is_err()
    );
    let SalonConfigurationWork::Conflict { id, write } = store.salon_configuration_work().unwrap()
    else {
        panic!("Queued settings must survive a restore as a conflict");
    };
    assert_eq!(id, original.mutation_id);
    let mut current = reviewed.clone();
    current.generation = "restored".into();
    current.revision += chrono::Duration::days(1);
    current.settings.min_notice_minutes = 90;
    store
        .apply_sync_page(&[], 0, false, true, &[], Some("restored"))
        .unwrap();
    let rebased = write.review_against(&current.settings).unwrap();
    assert_eq!(rebased.min_notice_minutes, 90);
    assert!(!rebased.online_booking_enabled);
    assert!(
        store
            .queue_salon_configuration(&current, &rebased, Some(&id))
            .unwrap()
    );
    assert!(store.conflict(&id).unwrap().is_none());
    assert_ne!(store.outbox(1).unwrap()[0].mutation_id, id);
}

#[test]
fn a_settings_tombstone_invalidates_the_owner_copy_and_late_gets() {
    let mut store = Store::open_in_memory().unwrap();
    let reviewed: ReviewedSalonConfiguration = serde_json::from_value(json!({
        "generation": INITIAL_GENERATION, "revision": "2026-11-21T00:00:00Z",
        "name": "Studio", "timezone": "Europe/Madrid", "slotGranularityMinutes": 15,
        "minNoticeMinutes": 30, "maxDaysAhead": 60, "onlineBookingEnabled": true,
        "reminderFirstLeadMinutes": 1440, "reminderSecondLeadMinutes": 120
    }))
    .unwrap();
    store.cache_salon_configuration(&reviewed).unwrap();
    store
        .apply_page(
            &[RawChange {
                seq: 1,
                entity: "salon_settings".into(),
                id: "1".into(),
                op: "delete".into(),
                data: None,
            }],
            1,
        )
        .unwrap();
    assert!(store.cached_salon_configuration().unwrap().is_none());
    assert!(store.cache_salon_configuration(&reviewed).is_err());
    let mut draft = reviewed.settings.clone();
    draft.online_booking_enabled = false;
    assert!(
        store
            .queue_salon_configuration(&reviewed, &draft, None)
            .is_err()
    );
}

#[test]
fn review_refresh_advances_the_topic_without_replica_changes() {
    let mut store = Store::open_in_memory().unwrap();
    assert_eq!(store.live_view_revision("review_requests").unwrap(), 0);
    assert_eq!(
        store
            .apply_sync_page(&[], 7, false, false, &["review_requests".into()], None)
            .unwrap(),
        0,
    );
    assert_eq!(store.live_view_revision("review_requests").unwrap(), 7);
    store
        .apply_sync_page(&[], 8, false, false, &[], None)
        .unwrap();
    assert_eq!(store.live_view_revision("review_requests").unwrap(), 7);
    store
        .apply_page(&[staff_change(9, "manager", "Manager")], 9)
        .unwrap();
    assert_eq!(store.live_view_revision("review_requests").unwrap(), 9);
}

#[test]
fn intake_markers_survive_reopening_the_replica_without_private_rows() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("replica.sqlite");
    let mut store = Store::open(&path).unwrap();
    let topics = [
        crate::intake::FORM_LIVE_TOPIC,
        crate::intake::RECORD_LIVE_TOPIC,
    ];
    let refresh = topics.map(str::to_owned);
    store
        .apply_sync_page(&[], 5, false, false, &refresh, None)
        .unwrap();
    drop(store);
    let reopened = Store::open(&path).unwrap();
    for topic in topics {
        assert_eq!(reopened.live_view_revision(topic).unwrap(), 5);
    }
    assert!(reopened.clients().unwrap().is_empty());
    assert!(reopened.outbox(20).unwrap().is_empty());
}

#[test]
fn staff_directory_revision_advances_only_for_new_staff_rows() {
    let mut store = Store::open_in_memory().unwrap();
    let change = staff_change(3, "manager", "Manager");
    assert_eq!(store.staff_directory_revision().unwrap(), 0);
    store.apply_page(std::slice::from_ref(&change), 3).unwrap();
    assert_eq!(store.staff_directory_revision().unwrap(), 3);
    store.apply_page(&[change], 7).unwrap();
    assert_eq!(store.staff_directory_revision().unwrap(), 3);
    store
        .apply_page(&[staff_change(8, "manager", "Manager")], 8)
        .unwrap();
    assert_eq!(store.staff_directory_revision().unwrap(), 8);
    store.reset_replica().unwrap();
    assert_eq!(store.staff_directory_revision().unwrap(), 0);
}

pub fn staff_change(seq: i64, id: &str, name: &str) -> RawChange {
    RawChange {
        seq,
        entity: "staff".into(),
        id: id.into(),
        op: "upsert".into(),
        data: Some(
            json!({"id": id, "displayName": name, "active": true, "userId": null,
            "updatedAt": "2026-03-01T10:00:00.000Z"}),
        ),
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
        data: Some(appt_json(
            id,
            "st1",
            "2026-03-09T12:00:00.000Z",
            "2026-03-09T13:00:00.000Z",
            version,
        )),
    }
}

pub fn tombstone(seq: i64, entity: &str, id: &str) -> RawChange {
    RawChange {
        seq,
        entity: entity.into(),
        id: id.into(),
        op: "delete".into(),
        data: None,
    }
}

const A1: &str = "01a1d81e-0000-7000-8000-0000000000a1";
const A2: &str = "01a1d81e-0000-7000-8000-0000000000a2";

#[test]
fn migrations_run_once_and_survive_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("replica.db");
    {
        let mut conn = Connection::open(&path).unwrap();
        for sql in &MIGRATIONS[..2] {
            conn.execute_batch(sql).unwrap();
        }
        conn.pragma_update(None, "user_version", 2).unwrap();
        let tx = conn.transaction().unwrap();
        apply_change(&tx, &staff_change(3, "st1", "Ana")).unwrap();
        tx.execute("INSERT INTO meta (key,value) VALUES ('cursor','3')", [])
            .unwrap();
        tx.commit().unwrap();
    }
    let s = Store::open(&path).unwrap();
    assert_eq!(s.schema_version().unwrap() as usize, MIGRATIONS.len());
    assert_eq!(s.staff().unwrap().len(), 1);
    assert_eq!(s.cursor().unwrap(), 3);
}

#[test]
fn an_upgrade_refreshes_legacy_billing_holds_without_discarding_the_mirror_or_outbox() {
    let mut conn = Connection::open_in_memory().unwrap();
    for sql in &MIGRATIONS[..5] {
        conn.execute_batch(sql).unwrap();
    }
    conn.pragma_update(None, "user_version", 5).unwrap();
    let tx = conn.transaction().unwrap();
    let mut imported = appt_change(5, A1, 1);
    let data = imported.data.as_mut().unwrap();
    data["importedFromBooksy"] = json!(true);
    data["services"][0]["sourceUnpriced"] = json!(true);
    data["billingReviewReasons"] = json!(["unknown_amount"]);
    apply_change(&tx, &imported).unwrap();
    tx.execute("INSERT INTO meta (key,value) VALUES ('cursor','5')", [])
        .unwrap();
    tx.execute(
        "INSERT INTO outbox (mutation_id, created_at, kind, entity_id, payload)
        VALUES ('queued','2026-11-21T09:00:00Z','appointment.move',?1,'{}')",
        [A1],
    )
    .unwrap();
    tx.commit().unwrap();
    let mut store = Store::init(conn).unwrap();
    assert_eq!(store.cursor().unwrap(), 0);
    assert!(store.appointment(A1).unwrap().is_some());
    assert_eq!(store.outbox(1).unwrap()[0].mutation_id, "queued");
    imported.data.as_mut().unwrap()["billingReviewReasons"] =
        json!(["unknown_amount", "unknown_booksy_payment"]);
    store.apply_page(&[imported], 5).unwrap();
    assert!(
        store
            .appointment(A1)
            .unwrap()
            .unwrap()
            .billing_review_reasons()
            .any(|reason| reason == crate::model::BillingReviewReason::UnknownBooksyPayment)
    );
    assert_eq!(store.cursor().unwrap(), 5);
    assert_eq!(store.outbox(1).unwrap()[0].mutation_id, "queued");
}

#[test]
fn booking_notices_skip_snapshot_import_and_local_echo_and_follow_visibility() {
    let mut store = Store::open_in_memory().unwrap();
    store
        .apply_sync_page(&[appt_change(1, A1, 1)], 1, false, false, &[], None)
        .unwrap();
    assert!(
        store
            .get_meta("calendar_snapshot_complete")
            .unwrap()
            .is_none()
    );
    store
        .apply_sync_page(&[appt_change(2, A2, 1)], 2, false, true, &[], None)
        .unwrap();
    assert!(
        store
            .get_meta("calendar_snapshot_complete")
            .unwrap()
            .is_some()
    );
    assert_eq!(store.booking_notice_head().unwrap(), 0);

    let own = store
        .enqueue("appointment.create", "own", json!({"id": "own"}))
        .unwrap();
    store
        .apply_push_results(std::slice::from_ref(&own), &[applied(&own.mutation_id)])
        .unwrap();
    assert_eq!(store.outbox_len().unwrap(), 0);
    let mut imported = appt_change(4, "imported", 1);
    imported.data.as_mut().unwrap()["visitGroupId"] = json!("source-visit");
    let mut legacy = appt_change(5, "legacy", 1);
    legacy.data.as_mut().unwrap()["importedFromBooksy"] = json!(true);
    let mut new = appt_change(6, "new", 1);
    new.data.as_mut().unwrap()["clientName"] = json!("Lucía");
    store
        .apply_sync_page(
            &[appt_change(3, "own", 1), imported, legacy, new.clone()],
            6,
            true,
            true,
            &[],
            None,
        )
        .unwrap();
    store
        .apply_sync_page(&[new], 6, true, true, &[], None)
        .unwrap();
    let notices = store.booking_notices_after(0).unwrap();
    assert_eq!(notices.len(), 1);
    assert_eq!(notices[0].1.id, "new");
    assert_eq!(notices[0].1.client_name.as_deref(), Some("Lucía"));
    let cursor = notices[0].0;

    store
        .apply_sync_page(
            &[tombstone(7, "appointment", "new")],
            7,
            true,
            true,
            &[],
            None,
        )
        .unwrap();
    assert!(store.booking_notices_after(0).unwrap().is_empty());
    assert_eq!(store.booking_notice_head().unwrap(), 0);
    store.reset_replica().unwrap();
    assert!(
        store
            .get_meta("calendar_snapshot_complete")
            .unwrap()
            .is_none()
    );
    store
        .apply_sync_page(&[appt_change(1, "restored", 1)], 1, false, true, &[], None)
        .unwrap();
    store
        .apply_sync_page(&[appt_change(2, "another", 1)], 2, true, true, &[], None)
        .unwrap();
    assert_eq!(
        store.booking_notices_after(cursor).unwrap()[0].1.id,
        "another"
    );
}

#[test]
fn an_online_booking_marker_suppresses_only_the_origin_notification() {
    let mut origin = Store::open_in_memory().unwrap();
    let mut remote = Store::open_in_memory().unwrap();
    let generation = origin.refresh_reviewed_generation().unwrap();
    assert!(matches!(
        origin.mark_local_booking_dispatch(A1, "earlier"),
        Err(CoreError::CalendarGenerationChanged)
    ));
    origin.mark_local_booking_dispatch(A1, &generation).unwrap();
    origin.mark_local_booking_dispatch(A1, &generation).unwrap();
    for store in [&mut origin, &mut remote] {
        store
            .apply_sync_page(&[appt_change(1, A1, 1)], 1, true, true, &[], None)
            .unwrap();
        assert!(store.appointment(A1).unwrap().is_some());
        assert_eq!(store.outbox_len().unwrap(), 0);
    }
    assert!(origin.booking_notices_after(0).unwrap().is_empty());
    assert_eq!(remote.booking_notices_after(0).unwrap()[0].1.id, A1);
}

#[test]
fn booksy_origin_refreshes_an_existing_appointment_at_the_same_version() {
    let mut store = Store::open_in_memory().unwrap();
    let mut imported = appt_change(1, A1, 1);
    store.apply_page(&[imported.clone()], 1).unwrap();
    assert!(!store.appointment(A1).unwrap().unwrap().imported_from_booksy);

    imported.seq = 2;
    imported.data.as_mut().unwrap()["importedFromBooksy"] = json!(true);
    store
        .apply_sync_page(&[imported], 2, true, true, &[], None)
        .unwrap();
    let saved = store.appointment(A1).unwrap().unwrap();
    assert!(saved.imported_from_booksy);
    assert_eq!(saved.version, 1);
    assert_eq!(store.booking_notice_head().unwrap(), 0);
}

#[test]
fn replica_keeps_imported_group_billing_holds_and_reviewed_price_across_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("replica.db");
    {
        let mut store = Store::open(&path).unwrap();
        let mut imported = appt_change(1, A1, 1);
        let data = imported.data.as_mut().unwrap();
        data["visitGroupId"] = json!("imported-group");
        data["services"][0]["sourceUnpriced"] = json!(true);
        data["services"][0]["priceCents"] = json!(0);
        data["billingReviewReasons"] = json!(["unknown_amount"]);
        let mut paid = appt_change(2, A2, 1);
        paid.data.as_mut().unwrap()["billingReviewReasons"] =
            json!(["paid_in_booksy", "invoiced_in_booksy"]);
        store.apply_page(&[imported, paid], 2).unwrap();
    }
    let mut store = Store::open(&path).unwrap();
    let first = store.appointment(A1).unwrap().unwrap();
    let second = store.appointment(A2).unwrap().unwrap();
    assert_eq!(first.visit_group_id.as_deref(), Some("imported-group"));
    assert!(first.services[0].source_unpriced);
    assert_eq!(
        first.billing_review_reasons,
        [crate::model::BillingReviewReason::UnknownAmount]
    );
    assert!(second.visit_group_id.is_none());
    assert!(!second.services[0].source_unpriced);
    assert_eq!(
        second.billing_review_reasons,
        [
            crate::model::BillingReviewReason::PaidInBooksy,
            crate::model::BillingReviewReason::InvoicedInBooksy,
        ]
    );

    let mut reviewed = appt_change(3, A1, 2);
    reviewed.data.as_mut().unwrap()["services"][0]["priceCents"] = json!(3650);
    let mut credited = appt_change(4, A2, 2);
    credited.data.as_mut().unwrap()["externalBalance"] =
        json!({"paidInBooksyCents": 3500, "dueInCitameCents": 6500});
    store.apply_page(&[reviewed, credited], 4).unwrap();
    drop(store);
    let reopened = Store::open(&path).unwrap();
    let stored = reopened.appointment(A1).unwrap().unwrap();
    assert_eq!(stored.services[0].price_cents, 3650);
    assert!(!stored.services[0].source_unpriced);
    assert!(stored.billing_review_reasons.is_empty());
    let balance = reopened
        .appointment(A2)
        .unwrap()
        .unwrap()
        .external_balance
        .unwrap();
    assert_eq!(balance.paid_in_booksy_cents, 3500);
    assert_eq!(balance.due_in_citame_cents, 6500);
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
fn calendar_inbox_keeps_separate_pages_and_clears_on_replica_reset() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("inbox.db");
    let page = CalendarInbox {
        page: 1,
        page_size: 25,
        total: 1,
        entries: vec![],
    };
    let archived = CalendarInbox {
        total: 2,
        ..page.clone()
    };
    {
        let store = Store::open(&path).unwrap();
        store.cache_calendar_inbox(false, &page).unwrap();
        store.cache_calendar_inbox(true, &archived).unwrap();
    }
    let mut store = Store::open(&path).unwrap();
    assert_eq!(store.calendar_inbox_cache(false).unwrap(), Some(page));
    assert_eq!(store.calendar_inbox_cache(true).unwrap(), Some(archived));
    store.reset_replica().unwrap();
    assert!(store.calendar_inbox_cache(false).unwrap().is_none());
    assert!(store.calendar_inbox_cache(true).unwrap().is_none());
}

#[test]
fn cursor_is_persisted_with_the_page_and_never_decreases() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("replica.db");
    {
        let mut s = Store::open(&path).unwrap();
        assert_eq!(s.cursor().unwrap(), 0);
        s.apply_page(&[appt_change(5, A1, 1)], 5).unwrap();
        s.apply_page(&[appt_change(6, A1, 2)], 7).unwrap();
        s.apply_page(&[appt_change(4, A1, 1)], 4).unwrap();
        assert_eq!(s.appointment(A1).unwrap().unwrap().version, 2);
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
    s.apply_page(&[appt_change(1, A1, 1), appt_change(2, A1, 2)], 2)
        .unwrap();
    assert_eq!(s.appointment(A1).unwrap().unwrap().version, 2);
    assert_eq!(s.appointments_between(0, i64::MAX).unwrap().len(), 1);
}

#[test]
fn tombstones_delete_rows_and_are_a_noop_when_absent() {
    let mut s = Store::open_in_memory().unwrap();
    s.apply_page(&[appt_change(1, A1, 1), staff_change(2, "st1", "Ana")], 2)
        .unwrap();
    s.apply_page(
        &[
            tombstone(3, "appointment", A1),
            tombstone(4, "staff", "st1"),
        ],
        4,
    )
    .unwrap();
    s.apply_page(
        &[
            tombstone(5, "appointment", A1),
            tombstone(6, "time_off", "zzz"),
        ],
        6,
    )
    .unwrap();
    assert!(s.appointment(A1).unwrap().is_none());
    assert!(s.staff().unwrap().is_empty());
    assert_eq!(s.cursor().unwrap(), 6);
}

#[test]
fn unknown_entities_are_skipped_but_the_cursor_advances() {
    let mut s = Store::open_in_memory().unwrap();
    let c = RawChange {
        seq: 9,
        entity: "loyalty_card".into(),
        id: "x".into(),
        op: "upsert".into(),
        data: Some(json!({})),
    };
    s.apply_page(&[c], 9).unwrap();
    assert_eq!(s.cursor().unwrap(), 9);
}

#[test]
fn appointments_between_returns_only_overlapping_rows() {
    let mut s = Store::open_in_memory().unwrap();
    s.apply_page(&[appt_change(1, A1, 1)], 1).unwrap();
    let t = |iso: &str| {
        chrono::DateTime::parse_from_rfc3339(iso)
            .unwrap()
            .timestamp_millis()
    };
    assert_eq!(
        s.appointments_between(t("2026-03-09T12:30:00Z"), t("2026-03-09T14:00:00Z"))
            .unwrap()
            .len(),
        1
    );
    assert!(
        s.appointments_between(t("2026-03-09T13:00:00Z"), t("2026-03-09T14:00:00Z"))
            .unwrap()
            .is_empty()
    );
    assert!(
        s.appointments_between(t("2026-03-09T00:00:00Z"), t("2026-03-09T12:00:00Z"))
            .unwrap()
            .is_empty()
    );
}

#[test]
fn outbox_keeps_creation_order_and_uuidv7_mutation_ids() {
    let mut s = Store::open_in_memory().unwrap();
    let a = s
        .enqueue("appointment.create", A1, json!({"id": A1}))
        .unwrap();
    let b = s
        .enqueue("appointment.cancel", A1, json!({"id": A1, "version": 2}))
        .unwrap();
    let c = s
        .enqueue("client.create", "c9", json!({"id": "c9"}))
        .unwrap();
    assert!(a.seq < b.seq && b.seq < c.seq);
    for e in [&a, &b, &c] {
        let u = uuid::Uuid::parse_str(&e.mutation_id).unwrap();
        assert_eq!(u.get_version_num(), 7);
    }
    let q = s.outbox(2).unwrap();
    assert_eq!(
        q.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(),
        ["appointment.create", "appointment.cancel"]
    );
    assert_eq!(s.outbox_len().unwrap(), 3);
}

#[test]
fn outbox_survives_reopen_with_a_stable_created_at() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("replica.db");
    let e = Store::open(&path)
        .unwrap()
        .enqueue("appointment.cancel", A1, json!({"id": A1, "version": 1}))
        .unwrap();
    let again = Store::open(&path).unwrap().outbox(10).unwrap();
    assert_eq!(again, vec![e]);
}

fn applied(id: &str) -> MutationResult {
    MutationResult::Applied {
        mutation_id: id.into(),
        applied_seq: Some(1),
        replayed: false,
    }
}

#[test]
fn applied_results_leave_the_outbox() {
    let mut s = Store::open_in_memory().unwrap();
    let a = s
        .enqueue("client.create", "c1", json!({"id": "c1"}))
        .unwrap();
    let r = s
        .apply_push_results(std::slice::from_ref(&a), &[applied(&a.mutation_id)])
        .unwrap();
    assert_eq!(
        r,
        PushApplied {
            applied: 1,
            rejected: 0,
            retry_pending: false
        }
    );
    assert_eq!(s.outbox_len().unwrap(), 0);
}

#[test]
fn rejected_results_leave_the_outbox_and_become_conflicts() {
    let mut s = Store::open_in_memory().unwrap();
    let a = s
        .enqueue("appointment.create", A1, json!({"id": A1}))
        .unwrap();
    assert_eq!(
        s.appointment_edit_sync(A1).unwrap(),
        AppointmentEditSync::Pending
    );
    assert_eq!(
        s.appointment_edit_sync("unrelated").unwrap(),
        AppointmentEditSync::Settled
    );
    let rej = MutationResult::Rejected {
        mutation_id: a.mutation_id.clone(),
        reason: "slot_taken".into(),
        message: "The selected time slot is no longer available".into(),
        replayed: false,
    };
    let r = s
        .apply_push_results(std::slice::from_ref(&a), &[rej])
        .unwrap();
    assert_eq!(r.rejected, 1);
    assert_eq!(s.outbox_len().unwrap(), 0);
    let conflicts = s.conflicts().unwrap();
    assert_eq!(conflicts.len(), 1);
    assert_eq!(conflicts[0].reason, "slot_taken");
    assert_eq!(conflicts[0].entity_id, A1);
    assert_eq!(conflicts[0].payload, json!({"id": A1}));
    assert_eq!(
        s.appointment_edit_sync(A1).unwrap(),
        AppointmentEditSync::NeedsResolution
    );
    s.resolve_conflict(&a.mutation_id, "drop").unwrap();
    assert_eq!(
        s.appointment_edit_sync(A1).unwrap(),
        AppointmentEditSync::Settled
    );
}

#[test]
fn a_retry_result_keeps_it_and_everything_after_it_queued() {
    let mut s = Store::open_in_memory().unwrap();
    let a = s
        .enqueue("client.create", "c1", json!({"id": "c1"}))
        .unwrap();
    let b = s
        .enqueue("client.create", "c2", json!({"id": "c2"}))
        .unwrap();
    let c = s
        .enqueue("client.create", "c3", json!({"id": "c3"}))
        .unwrap();
    let sent = vec![a.clone(), b.clone(), c.clone()];
    let results = vec![
        applied(&a.mutation_id),
        MutationResult::Retry {
            mutation_id: b.mutation_id.clone(),
            message: "busy".into(),
        },
        applied(&c.mutation_id), // must be ignored: it is after the retry
    ];
    let r = s.apply_push_results(&sent, &results).unwrap();
    assert_eq!(
        r,
        PushApplied {
            applied: 1,
            rejected: 0,
            retry_pending: true
        }
    );
    let left: Vec<_> = s
        .outbox(10)
        .unwrap()
        .into_iter()
        .map(|e| e.mutation_id)
        .collect();
    assert_eq!(left, vec![b.mutation_id, c.mutation_id]);
}

#[test]
fn results_out_of_order_or_short_are_a_protocol_error_and_change_nothing() {
    let mut s = Store::open_in_memory().unwrap();
    let a = s
        .enqueue("client.create", "c1", json!({"id": "c1"}))
        .unwrap();
    let b = s
        .enqueue("client.create", "c2", json!({"id": "c2"}))
        .unwrap();
    let sent = vec![a.clone(), b.clone()];
    assert!(
        s.apply_push_results(&sent, &[applied(&b.mutation_id), applied(&a.mutation_id)])
            .is_err()
    );
    assert!(
        s.apply_push_results(&sent, &[applied(&a.mutation_id)])
            .is_err()
    );
    assert_eq!(s.outbox_len().unwrap(), 2);
}

#[test]
fn distinct_rejected_edits_survive_and_replaying_a_rejection_does_not_duplicate_it() {
    let mut s = Store::open_in_memory().unwrap();
    let create = s
        .enqueue("appointment.create", A1, json!({"id": A1}))
        .unwrap();
    let cancel = s
        .enqueue("appointment.cancel", A1, json!({"id": A1, "version": 2}))
        .unwrap();
    let rej = |e: &OutboxEntry, reason: &str| MutationResult::Rejected {
        mutation_id: e.mutation_id.clone(),
        reason: reason.into(),
        message: "m".into(),
        replayed: false,
    };
    let sent = vec![create.clone(), cancel.clone()];
    s.apply_push_results(
        &sent,
        &[rej(&create, "slot_taken"), rej(&cancel, "not_found")],
    )
    .unwrap();
    s.apply_push_results(std::slice::from_ref(&cancel), &[rej(&cancel, "not_found")])
        .unwrap();
    let c = s.conflicts().unwrap();
    assert_eq!(c.len(), 2);
    assert_eq!(c[0].reason, "slot_taken");
    assert_eq!(c[1].payload, json!({"id": A1, "version": 2}));
}

#[test]
fn resolved_conflicts_disappear_from_the_open_list() {
    let mut s = Store::open_in_memory().unwrap();
    let a = s
        .enqueue("appointment.create", A1, json!({"id": A1}))
        .unwrap();
    let rej = MutationResult::Rejected {
        mutation_id: a.mutation_id.clone(),
        reason: "slot_taken".into(),
        message: "m".into(),
        replayed: false,
    };
    s.apply_push_results(std::slice::from_ref(&a), &[rej])
        .unwrap();
    s.resolve_conflict(&a.mutation_id, "dismissed").unwrap();
    assert!(s.conflicts().unwrap().is_empty());
}

#[test]
fn failures_are_counted_on_the_queued_mutation() {
    let mut s = Store::open_in_memory().unwrap();
    let a = s
        .enqueue("client.create", "c1", json!({"id": "c1"}))
        .unwrap();
    s.record_failure(std::slice::from_ref(&a.mutation_id), "connection refused")
        .unwrap();
    let e = &s.outbox(1).unwrap()[0];
    assert_eq!(e.attempts, 1);
    assert_eq!(e.last_error.as_deref(), Some("connection refused"));
}

#[test]
fn resetting_the_replica_drops_the_mirror_and_cursor_but_keeps_the_outbox() {
    let mut s = Store::open_in_memory().unwrap();
    s.apply_page(&[appt_change(1, A1, 1)], 40).unwrap();
    s.apply_catalog_colors(&CatalogColors::new(), None).unwrap();
    s.enqueue("client.create", "c1", json!({"id": "c1"}))
        .unwrap();
    let dev = s.device_id().unwrap();
    s.reset_replica().unwrap();
    assert_eq!(s.cursor().unwrap(), 0);
    assert!(s.appointment(A1).unwrap().is_none());
    assert!(s.get_meta(CATALOG_COLORS_CACHED).unwrap().is_none());
    assert_eq!(s.outbox_len().unwrap(), 1);
    assert_eq!(s.device_id().unwrap(), dev);
}

#[test]
fn dated_shift_replica_distinguishes_closed_from_weekly_and_resets_with_the_mirror() {
    let mut store = Store::open_in_memory().unwrap();
    let row = |seq, ranges: Value, version| RawChange {
        seq,
        entity: "date_shift".into(),
        id: "shift1".into(),
        op: "upsert".into(),
        data: Some(
            json!({ "id": "shift1", "staffId": "staff1", "date": "2026-03-09", "ranges": ranges, "version": version, "updatedAt": "2026-03-02T12:00:00.000Z" }),
        ),
    };
    store.apply_page(&[row(1, json!([]), 1)], 1).unwrap();
    assert_eq!(store.date_shifts().unwrap()[0].ranges, Some(vec![]));
    store.apply_page(&[row(2, Value::Null, 2)], 2).unwrap();
    assert_eq!(store.date_shifts().unwrap()[0].ranges, None);
    assert_eq!(store.date_shifts().unwrap()[0].version, 2);
    store.reset_replica().unwrap();
    assert!(store.date_shifts().unwrap().is_empty());
}

#[test]
fn dated_shift_migration_keeps_an_existing_replica_cursor_and_outbox() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("old-replica.db");
    {
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(MIGRATIONS[0]).unwrap();
        conn.pragma_update(None, "user_version", 1).unwrap();
        conn.execute("INSERT INTO meta(key,value) VALUES('cursor','42')", [])
            .unwrap();
        conn.execute("INSERT INTO outbox(mutation_id,created_at,kind,entity_id,payload) VALUES('pending','2026-03-01T12:00:00.000Z','client.create','c1','{}')",[]).unwrap();
    }
    let store = Store::open(&path).unwrap();
    assert_eq!(store.cursor().unwrap(), 42);
    assert_eq!(store.outbox_len().unwrap(), 1);
    assert!(store.date_shifts().unwrap().is_empty());
}

#[test]
fn visit_group_reads_only_related_cached_appointments_with_current_outcomes() {
    let mut store = Store::open_in_memory().unwrap();
    let mut current = appt_change(1, A1, 1);
    current.data.as_mut().unwrap()["visitGroupId"] = json!("group");
    let mut sibling = appt_change(2, A2, 1);
    let data = sibling.data.as_mut().unwrap();
    data["visitGroupId"] = json!("group");
    data["startsAt"] = json!("2026-03-10T12:00:00.000Z");
    data["endsAt"] = json!("2026-03-10T13:00:00.000Z");
    data["status"] = json!("cancelled");
    let mut unrelated = appt_change(3, "different-client", 1);
    let data = unrelated.data.as_mut().unwrap();
    data["clientId"] = json!("other");
    data["visitGroupId"] = json!("group");
    store.apply_page(&[current, sibling, unrelated], 3).unwrap();

    let current = store.appointment(A1).unwrap().unwrap();
    let group = crate::calendar::related_visit_appointments(&store, &current).unwrap();
    assert_eq!(group.len(), 1);
    assert_eq!(group[0].id, A2);
    assert_eq!(group[0].status, crate::model::AppointmentStatus::Cancelled);
    store
        .apply_page(&[tombstone(4, "appointment", A2)], 4)
        .unwrap();
    assert!(
        crate::calendar::related_visit_appointments(&store, &current)
            .unwrap()
            .is_empty()
    );
}
