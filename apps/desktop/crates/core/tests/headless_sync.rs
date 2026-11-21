//! Headless sync tests against the REAL API, Postgres and Valkey (no server mocks).
//!
//! They are `#[ignore]`d so a plain `cargo test` needs no infrastructure. Run them with a
//! dedicated database (see apps/desktop/README.md):
//!
//! ```text
//! SOB_TEST_API_URL=http://127.0.0.1:3055 \
//! SOB_TEST_EMAIL=owner@desktop.test SOB_TEST_PASSWORD=... \
//!   cargo test -p sob-core --test headless_sync -- --ignored --test-threads=1 --skip through_the_proxy
//! ```
//!
//! The proxy-specific tests require fixtures prepared by scripts/smoke-prod.sh.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock, RwLock};
use std::time::{Duration, Instant};

use chrono::{DateTime, Datelike, Duration as Span, NaiveTime, TimeZone, Utc};
use serde_json::json;
use sob_core::auth::{AuthProvider, BetterAuthSession, Credentials, SessionHandle};
use sob_core::billing::{
    CashAdjustment, CashCommand, CheckoutFinalPrice, ImportedPartialPaymentPreview,
    ImportedSettlement, PaymentAttempt, ReceiptTender,
};
use sob_core::billing::{SaleItem, WalkInSale};
use sob_core::calendar::{self, salon_tz};
use sob_core::http::{
    DatedShiftCopy, DatedShiftEdit, DatedShiftSelection, HttpTransport, spawn_stream_listener,
};
use sob_core::intake::Answer;
use sob_core::inventory::{
    ContentWriteError, LIVE_TOPIC as INVENTORY_TOPIC, LedgerQuery, PackageContent, PendingStock,
    ProductQuery, StockKind, StockWriteError,
};
use sob_core::model::*;
use sob_core::ops::{self, NewAppointment, Resolution};
use sob_core::reviews::{EmailStatus, ModerationCommand, ReviewStatus};
use sob_core::runner::{Connectivity, RunnerCore, SharedStatus, SyncRunner};
use sob_core::store::Store;
use sob_core::sync::{self, Transport, TransportError};
use sob_core::waitlist::{
    AcceptOffer, WaitlistPage, WaitlistPolicy, WaitlistRequest, WaitlistState,
};

#[path = "support/proxy_device.rs"]
mod proxy_device;
use proxy_device::ProxyDevice;

fn env(name: &str) -> String {
    std::env::var(name)
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| panic!("{name} must be set to run the headless sync tests"))
}

fn proxy_device() -> ProxyDevice {
    ProxyDevice::link(
        &env("SOB_TEST_API_URL"),
        &env("SOB_TEST_EMAIL"),
        &env("SOB_TEST_PASSWORD"),
    )
}

#[test]
#[ignore = "needs the real API behind the web gateway (see README)"]
fn desktop_opens_cloud_management_with_the_linked_users_web_session_through_the_proxy() {
    use sob_core::auth::BrowserWorkspace;
    let device = proxy_device();
    let workspaces = device.transport.browser_workspaces().unwrap();
    assert!(
        workspaces
            .iter()
            .any(|area| matches!(area, BrowserWorkspace::Settings))
    );
    device.assert_browser_workspace();
}

#[test]
#[ignore = "needs the real API behind the web gateway (see README)"]
fn native_administers_a_form_through_the_proxy() {
    use sob_core::intake::{FormDefinition, FormWrite, FormWriteError};
    let device = proxy_device();
    let browser = Device::sign_in();
    let transport = &device.transport;
    let definition: FormDefinition = serde_json::from_value(json!({
        "kind": "intake",
        "title": "Synthetic admin questionnaire",
        "description": "First paragraph\n\nSecond paragraph",
        "allServices": true,
        "requiredAtBooking": false,
        "allowTeamResponses": true,
        "fields": [{
            "id": uuid::Uuid::now_v7(),
            "label": "Count",
            "help": "",
            "required": false,
            "kind": "number",
            "minimum": 0,
            "maximum": 5
        }]
    }))
    .unwrap();
    let create = FormWrite::Create {
        key: uuid::Uuid::now_v7().to_string(),
        definition,
    };
    let saved = transport.write_intake_form(&create, None).unwrap();
    assert_eq!(
        transport.write_intake_form(&create, None).unwrap().id,
        saved.id
    );
    let summary = transport
        .intake_forms()
        .unwrap()
        .into_iter()
        .find(|row| row.id == saved.id)
        .unwrap();
    assert_eq!(summary.title, saved.draft.title);
    assert_eq!(summary.published_number, None);
    let read = transport.intake_form(&saved.id).unwrap();
    assert_eq!(read.draft, saved.draft);
    let publish = FormWrite::Publish {
        id: saved.id.clone(),
        version: saved.version,
    };
    let published = transport.write_intake_form(&publish, None).unwrap();
    assert!(published.active);
    assert!(!published.can_publish());
    assert!(matches!(
        transport.write_intake_form(&publish, None),
        Err(FormWriteError::Conflict)
    ));
    assert_eq!(
        transport
            .write_intake_form(&publish, Some(&saved))
            .unwrap()
            .version,
        published.version
    );
    let cloud = browser.rest_get("/admin/intake-forms");
    assert!(
        cloud["forms"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["id"] == saved.id && item["published"]["number"] == 1)
    );
    let archive = FormWrite::Archive {
        id: saved.id.clone(),
        version: published.version,
    };
    let archived = transport.write_intake_form(&archive, None).unwrap();
    assert!(!archived.active);
    assert_eq!(archived.published.unwrap().number, 1);
}

#[test]
#[ignore = "needs the real API behind the web gateway (see README)"]
fn native_records_and_reads_private_intake_through_the_proxy() {
    use sob_core::intake::{
        FORM_LIVE_TOPIC, FormDefinition, FormWrite, RECORD_LIVE_TOPIC, RecordError, RecordResponse,
        ResponseSource,
    };
    let mut browser = Device::sign_in();
    browser.sync();
    let catalog = catalog(&browser);
    let client =
        ops::create_client(&mut browser.store, "Synthetic response subject", None).unwrap();
    let other = ops::create_client(&mut browser.store, "Synthetic other subject", None).unwrap();
    browser.sync();
    let device = proxy_device();
    let transport = &device.transport;
    let replica_dir = tempfile::tempdir().unwrap();
    let path = replica_dir.path().join("intake.sqlite");
    let status: SharedStatus = Default::default();
    let runner = SyncRunner::spawn(RunnerCore::new(
        Store::open(&path).unwrap(),
        device.transport.clone(),
        status.clone(),
    ));
    let live = Arc::new(AtomicBool::new(false));
    let stop = Arc::new(AtomicBool::new(false));
    let listener = spawn_stream_listener(
        device.transport.clone(),
        runner.sender(),
        live.clone(),
        stop.clone(),
    );
    wait(Duration::from_secs(10), "the native intake stream", || {
        status.lock().unwrap().connectivity == Connectivity::Online && live.load(Ordering::SeqCst)
    });
    let replica = Store::open(&path).unwrap();
    let initial_form_revision = replica.live_view_revision(FORM_LIVE_TOPIC).unwrap();
    let initial_response_revision = replica.live_view_revision(RECORD_LIVE_TOPIC).unwrap();
    let question = uuid::Uuid::now_v7().to_string();
    let definition: FormDefinition = serde_json::from_value(json!({
        "title": "Synthetic frozen response history",
        "description": "",
        "allServices": false,
        "serviceIds": [catalog.haircut.clone()],
        "requiredAtBooking": false,
        "allowTeamResponses": true,
        "fields": [{
            "id": question,
            "label": "Applicable?",
            "help": "",
            "required": true,
            "kind": "boolean"
        }]
    }))
    .unwrap();
    let form = transport
        .write_intake_form(
            &FormWrite::Create {
                key: uuid::Uuid::now_v7().to_string(),
                definition,
            },
            None,
        )
        .unwrap();
    let published = transport
        .write_intake_form(
            &FormWrite::Publish {
                id: form.id.clone(),
                version: form.version,
            },
            None,
        )
        .unwrap();
    wait(
        Duration::from_secs(5),
        "the form publication marker",
        || replica.live_view_revision(FORM_LIVE_TOPIC).unwrap() > initial_form_revision,
    );
    assert!(
        transport
            .client_recording_catalog(&client)
            .unwrap()
            .get(&catalog.haircut)
            .is_some()
    );
    let terms = transport
        .client_recording_forms(&client, &[catalog.haircut])
        .unwrap();
    let required = terms
        .forms
        .iter()
        .find(|form| form.definition.title == "Synthetic frozen response history")
        .unwrap();
    let response = required
        .definition
        .team_response(
            &required.id,
            true,
            [(question.clone(), Answer::Boolean(false))]
                .into_iter()
                .collect(),
        )
        .unwrap();
    let packet = RecordResponse::new(&client, response).unwrap();
    transport.record_client_response(&packet).unwrap();
    transport.record_client_response(&packet).unwrap();
    let history = transport.client_response_history(&client, None).unwrap();
    assert_eq!(history.submissions.len(), 1);
    let summary = &history.submissions[0];
    let record = transport
        .client_recorded_response(&client, &summary.id)
        .unwrap();
    assert_eq!(record.revision.id, required.id);
    assert!(record.source == ResponseSource::Team);
    assert!(matches!(
        record.answers.get(&question),
        Some(Answer::Boolean(false))
    ));
    assert!(matches!(
        transport.client_recorded_response(&other, &summary.id),
        Err(RecordError::Missing)
    ));
    let cloud = browser.rest_get(&format!("/intake/submissions/{}", summary.id));
    assert_eq!(cloud["answers"][&question], false);
    wait(Duration::from_secs(5), "the native response marker", || {
        replica.live_view_revision(RECORD_LIVE_TOPIC).unwrap() > initial_response_revision
    });
    let before_web = replica.live_view_revision(RECORD_LIVE_TOPIC).unwrap();
    let web = browser.rest_post(
        &format!("/admin/clients/{client}/intake"),
        json!({
            "idempotencyKey": uuid::Uuid::now_v7(),
            "revisionId": required.id,
            "confirmation": true,
            "answers": { (&question): true }
        }),
    );
    wait(
        Duration::from_secs(5),
        "the web response marker reaching another native session",
        || replica.live_view_revision(RECORD_LIVE_TOPIC).unwrap() > before_web,
    );
    assert!(
        transport
            .client_response_history(&client, None)
            .unwrap()
            .submissions
            .iter()
            .any(|entry| entry.id == web["id"])
    );
    transport
        .write_intake_form(
            &FormWrite::Archive {
                id: published.id,
                version: published.version,
            },
            None,
        )
        .unwrap();
    assert_eq!(
        transport
            .client_recorded_response(&client, &summary.id)
            .unwrap()
            .revision
            .id,
        required.id
    );
    stop.store(true, Ordering::SeqCst);
    listener.join().unwrap();
    runner.stop();
    browser.sync();
    assert!(browser.store.outbox(20).unwrap().is_empty());
}

#[test]
#[ignore = "needs the real API behind the web gateway (see README)"]
fn desktop_opens_the_exact_receipt_and_observes_its_browser_payment_through_the_proxy() {
    let device = proxy_device();
    let receipt = device
        .transport
        .create_walk_in_sale(&WalkInSale {
            idempotency_key: uuid::Uuid::now_v7(),
            client_id: None,
            staff_id: None,
            use_client_discount: None,
            lines: vec![SaleItem::Custom {
                description: "Synthetic receipt handoff".into(),
                unit_amount_cents: 1800,
                quantity: 1,
            }],
            discount_cents: 0,
            tip_cents: 0,
        })
        .unwrap();
    assert_eq!(receipt.status, "open");
    let cookie = device.browser_receipt_cookie(receipt.id.parse().unwrap());

    let profile = tempfile::tempdir().unwrap();
    let store_path = profile.path().join("receipt.sqlite");
    let replica = Store::open(&store_path).unwrap();
    let status: SharedStatus = Default::default();
    let runner = SyncRunner::spawn(RunnerCore::new(
        Store::open(&store_path).unwrap(),
        device.transport.clone(),
        status.clone(),
    ));
    let live = Arc::new(AtomicBool::new(false));
    let stop = Arc::new(AtomicBool::new(false));
    let listener = spawn_stream_listener(
        device.transport.clone(),
        runner.sender(),
        live.clone(),
        stop.clone(),
    );
    wait(Duration::from_secs(5), "native receipt watcher", || {
        status.lock().unwrap().connectivity == Connectivity::Online && live.load(Ordering::SeqCst)
    });
    let before = replica.live_view_revision("commerce").unwrap();
    device.pay_receipt_from_browser(receipt.id.parse().unwrap(), 1800, &cookie);
    wait(
        Duration::from_secs(3),
        "browser payment to reach native",
        || replica.live_view_revision("commerce").unwrap() > before,
    );
    let paid = device.transport.refresh_checkout(&receipt).unwrap();
    assert_eq!(paid.status, "paid");
    assert_eq!(paid.paid_cents, 1800);
    stop.store(true, Ordering::SeqCst);
    runner.stop();
    drop(listener);
}

#[test]
#[ignore = "needs the real API behind the web gateway (see README)"]
fn native_dated_shift_commits_and_replays_through_the_proxy() {
    let mut observer = Device::sign_in();
    observer.sync();
    let staff = catalog(&observer).staff;
    let date = free_slot(&observer, &staff)
        .with_timezone(&salon_tz(&observer.store).unwrap())
        .date_naive();
    let device = proxy_device();
    let before = device.transport.dated_shift(&staff, date).unwrap();
    assert!(before.ranges.is_none());
    let review = |ranges| {
        device
            .transport
            .review_dated_shifts(
                &staff,
                DatedShiftSelection::Edit {
                    changes: [DatedShiftEdit { date, ranges }],
                },
            )
            .unwrap()
    };
    let close = review(Some(Vec::new()));
    assert_eq!(close.review.changes[0].previous, before);
    let closed = device
        .transport
        .commit_dated_shifts(&close)
        .unwrap()
        .unwrap()
        .remove(0);
    assert_eq!(closed.ranges, Some(Vec::new()));
    assert_eq!(closed.version, before.version + 1);
    assert_eq!(
        device.transport.commit_dated_shifts(&close).unwrap(),
        Some(vec![closed.clone()])
    );
    observer.sync();
    assert!(observer.store.date_shifts().unwrap().iter().any(|shift| {
        shift.staff_id == staff
            && shift.date == date.to_string()
            && shift.ranges == Some(Vec::new())
    }));

    let restore = review(None);
    let stale = review(Some(vec![DateShiftRange {
        start_time: "09:00".into(),
        end_time: "18:00".into(),
    }]));
    let restored = device
        .transport
        .commit_dated_shifts(&restore)
        .unwrap()
        .unwrap()
        .remove(0);
    assert!(restored.ranges.is_none());
    assert_eq!(restored.effective_ranges, before.effective_ranges);
    assert_eq!(restored.version, closed.version + 1);
    assert!(
        device
            .transport
            .commit_dated_shifts(&stale)
            .unwrap()
            .is_none()
    );
    assert_eq!(
        device.transport.dated_shift(&staff, date).unwrap(),
        restored
    );
}

#[test]
#[ignore = "needs the real API behind the web gateway (see README)"]
fn native_dated_shift_copy_reviews_and_syncs_all_target_dates_through_the_proxy() {
    let mut observer = Device::sign_in();
    observer.sync();
    let catalog = catalog(&observer);
    let staff = &catalog.staff;
    let timezone = salon_tz(&observer.store).unwrap();
    let overrides = observer.store.date_shifts().unwrap();
    // This scenario closes the source and writes four target days. A free source
    // slot can still correspond to a busy target after earlier scenarios ran.
    let source_slot = free_slot_matching(&observer, staff, |candidate| {
        let source = candidate.with_timezone(&timezone).date_naive();
        [0, 1, 7, 8, 14, 15].into_iter().all(|offset| {
            let date = source + chrono::Days::new(offset);
            if overrides.iter().any(|shift| {
                &shift.staff_id == staff && shift.date == date.to_string() && shift.ranges.is_some()
            }) {
                return false;
            }
            let (from, to) = calendar::local_day_range(timezone, date);
            let from = from.timestamp_millis();
            let to = to.timestamp_millis();
            !observer
                .store
                .appointments_between(from, to)
                .unwrap()
                .iter()
                .any(|visit| {
                    &visit.staff_id == staff && visit.status != AppointmentStatus::Cancelled
                })
                && !observer
                    .store
                    .time_off_between(from, to)
                    .unwrap()
                    .iter()
                    .any(|block| &block.staff_id == staff)
        })
    })
    .with_timezone(&timezone);
    let source = source_slot.date_naive();
    let target = source + chrono::Days::new(7);
    let target_slot = timezone
        .from_local_datetime(&target.and_time(source_slot.time()))
        .single()
        .unwrap()
        .with_timezone(&Utc);
    let client = ops::create_client(&mut observer.store, "Synthetic shift review", None).unwrap();
    let appointment = ops::create_appointment(
        &mut observer.store,
        booking(&catalog, staff, &client, target_slot),
    )
    .unwrap();
    observer.sync();
    let original_appointment = observer.store.appointment(&appointment).unwrap().unwrap();
    let device = proxy_device();
    let copy = || DatedShiftSelection::Copy(DatedShiftCopy::new(source, 2, target, 2).unwrap());
    let dates = [0, 1, 7, 8].map(|offset| target + chrono::Days::new(offset));
    let base = device.transport.dated_shift(staff, source).unwrap();
    assert!(!base.effective_ranges.is_empty());
    let draft = device.transport.review_dated_shifts(staff, copy()).unwrap();
    assert!(
        draft
            .review
            .changes
            .iter()
            .map(|change| change.date)
            .eq(dates)
    );
    assert_eq!(
        draft.review.changes[0].next.ranges,
        Some(base.effective_ranges.clone())
    );

    let edit_source = |ranges| {
        device
            .transport
            .review_dated_shifts(
                staff,
                DatedShiftSelection::Edit {
                    changes: [DatedShiftEdit {
                        date: source,
                        ranges,
                    }],
                },
            )
            .unwrap()
    };
    assert!(
        device
            .transport
            .commit_dated_shifts(&edit_source(Some(vec![])))
            .unwrap()
            .is_some()
    );
    assert_eq!(device.transport.commit_dated_shifts(&draft).unwrap(), None);
    let closed_review = device.transport.review_dated_shifts(staff, copy()).unwrap();
    assert!(closed_review.review.conflicts.iter().any(|conflict| {
        conflict.appointment_id.to_string() == appointment
            && conflict.client_id.to_string() == client
            && conflict.starts_at == target_slot
    }));
    for change in &draft.review.changes {
        assert_eq!(
            device.transport.dated_shift(staff, change.date).unwrap(),
            change.previous
        );
    }
    assert!(
        device
            .transport
            .commit_dated_shifts(&edit_source(base.ranges))
            .unwrap()
            .is_some()
    );

    let review = device.transport.review_dated_shifts(staff, copy()).unwrap();
    let saved = device
        .transport
        .commit_dated_shifts(&review)
        .unwrap()
        .unwrap();
    assert!(saved.iter().map(|day| day.date).eq(dates));
    assert_eq!(
        device.transport.commit_dated_shifts(&review).unwrap(),
        Some(saved.clone())
    );
    observer.sync();
    let current_appointment = observer.store.appointment(&appointment).unwrap().unwrap();
    assert_eq!(current_appointment.status, original_appointment.status);
    assert_eq!(
        current_appointment.starts_at,
        original_appointment.starts_at
    );
    assert_eq!(current_appointment.ends_at, original_appointment.ends_at);
    let local = observer.store.date_shifts().unwrap();
    for day in saved {
        assert_eq!(day.ranges.as_ref(), Some(&day.effective_ranges));
        assert!(local.iter().any(|shift| &shift.staff_id == staff
            && shift.date == day.date.to_string()
            && shift.ranges == day.ranges));
    }
}

#[test]
#[ignore = "needs the real API behind the web gateway (see README)"]
fn native_weekly_hours_save_sync_and_reject_stale_replay_through_the_proxy() {
    let mut observer = Device::sign_in();
    observer.sync();
    let catalog = catalog(&observer);
    let staff = &catalog.staff;
    let starts_at = free_slot(&observer, staff);
    let date = starts_at
        .with_timezone(&salon_tz(&observer.store).unwrap())
        .date_naive();
    let weekday = date.weekday().num_days_from_sunday() as u8;
    let client =
        ops::create_client(&mut observer.store, "Synthetic schedule conflict", None).unwrap();
    let appointment = ops::create_appointment(
        &mut observer.store,
        booking(&catalog, staff, &client, starts_at),
    )
    .unwrap();
    observer.sync();

    let owner = proxy_device();
    assert!(
        owner
            .transport
            .dated_shift(staff, date)
            .unwrap()
            .ranges
            .is_none()
    );
    let initial = owner.transport.weekly_hours(staff).unwrap();
    let changed: Vec<_> = initial
        .hours
        .iter()
        .filter(|range| range.weekday != weekday)
        .cloned()
        .collect();
    let saved = owner
        .transport
        .save_weekly_hours(&initial, &changed)
        .unwrap()
        .unwrap();
    assert_eq!(saved.hours, changed);
    assert!(
        saved
            .conflicts
            .iter()
            .any(|row| row.appointment_id.to_string() == appointment)
    );
    assert!(
        owner
            .transport
            .save_weekly_hours(&initial, &changed)
            .unwrap()
            .is_some()
    );
    observer.sync();
    assert!(
        observer
            .store
            .working_hours()
            .unwrap()
            .iter()
            .all(|range| &range.staff_id != staff || range.weekday != i64::from(weekday))
    );
    ops::cancel_appointment(&mut observer.store, &appointment).unwrap();
    assert_eq!(
        observer.store.appointment_edit_sync(&appointment).unwrap(),
        AppointmentEditSync::Pending
    );
    observer.sync();
    assert_eq!(
        observer.store.appointment_edit_sync(&appointment).unwrap(),
        AppointmentEditSync::Settled
    );
    assert!(
        owner
            .transport
            .weekly_hours(staff)
            .unwrap()
            .conflicts
            .iter()
            .all(|row| row.appointment_id.to_string() != appointment)
    );

    let restored = owner
        .transport
        .save_weekly_hours(&saved, &initial.hours)
        .unwrap()
        .unwrap();
    assert_eq!(restored.hours, initial.hours);
    assert!(
        owner
            .transport
            .save_weekly_hours(&initial, &changed)
            .unwrap()
            .is_none()
    );
}

#[test]
#[ignore = "needs the private SMTP fixture from the production smoke test"]
fn native_review_requests_queue_and_replay_a_real_invitation_through_the_proxy() {
    let id = env("SOB_TEST_REVIEW_APPOINTMENT");
    let device = proxy_device();
    let page = device
        .transport
        .review_requests(1, " Smoke Client ")
        .unwrap();
    let visit = page
        .visits
        .iter()
        .find(|visit| visit.appointment_id == id)
        .unwrap();
    assert!(visit.can_email);
    assert_eq!(visit.email_status, None);
    assert!(page.email_enabled);
    assert_eq!(
        visit.link.as_deref(),
        Some(
            device
                .base
                .join(&format!("/account/reviews?appointmentId={id}"))
                .unwrap()
                .as_str()
        ),
    );
    assert_eq!(
        device.transport.request_review_email(&id).unwrap(),
        EmailStatus::Pending
    );
    let replay = device.transport.request_review_email(&id).unwrap();
    assert!(replay.is_pending() || replay == EmailStatus::Sent);

    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let page = device.transport.review_requests(1, "Smoke Client").unwrap();
        let visit = page
            .visits
            .iter()
            .find(|visit| visit.appointment_id == id)
            .unwrap();
        let status = visit.email_status.unwrap();
        if status == EmailStatus::Sent {
            break;
        }
        assert!(
            status.is_pending(),
            "review invitation failed with {status:?}"
        );
        assert!(
            Instant::now() < deadline,
            "SMTP did not deliver the review invitation"
        );
        std::thread::sleep(Duration::from_millis(500));
    }
    assert_eq!(
        device.transport.request_review_email(&id).unwrap(),
        EmailStatus::Sent
    );
    device.disconnect_and_check("/api/admin/reviews/requests");
    assert!(matches!(
        device.transport.review_requests(1, "Smoke Client"),
        Err(TransportError::Unauthorized)
    ));
}

struct Device {
    store: Store,
    transport: Arc<HttpTransport>,
    base: String,
    cookie: String,
    _dir: tempfile::TempDir,
    path: std::path::PathBuf,
}

#[test]
#[ignore = "needs the synthetic review from the production smoke test"]
fn native_moderation_publishes_replies_and_hides_through_the_proxy() {
    let id = env("SOB_TEST_MANAGED_REVIEW");
    let device = proxy_device();
    let page = device
        .transport
        .managed_reviews(Some(ReviewStatus::Pending), None)
        .unwrap();
    let review = page.reviews.iter().find(|review| review.id == id).unwrap();
    assert_eq!(review.body.as_deref(), Some("Synthetic desktop review"));
    let published = device
        .transport
        .update_managed_review(&id, review.version, ModerationCommand::Publish)
        .unwrap();
    assert_eq!(published.status, ReviewStatus::Published);
    let stale_reply = "Old draft";
    let rejected = device.transport.update_managed_review(
        &id,
        review.version,
        ModerationCommand::Reply(Some(stale_reply)),
    );
    assert!(matches!(rejected, Err(TransportError::BadRequest(_))));

    device.assert_stale_reply(&id, review.version, stale_reply);
    let reply = "Thanks for visiting.\nWe hope to see you soon.";
    let answered = device
        .transport
        .update_managed_review(
            &id,
            published.version,
            ModerationCommand::Reply(Some(reply)),
        )
        .unwrap();
    assert_eq!(answered.reply.as_deref(), Some(reply));
    let current = device.public_reviews();
    assert!(
        current["reviews"]
            .as_array()
            .unwrap()
            .iter()
            .any(|review| review["id"] == id && review["reply"] == reply)
    );
    let cleared = device
        .transport
        .update_managed_review(&id, answered.version, ModerationCommand::Reply(None))
        .unwrap();
    assert!(cleared.reply.is_none());
    let reason = "Synthetic moderation control";
    let hidden = device
        .transport
        .update_managed_review(&id, cleared.version, ModerationCommand::Hide(reason))
        .unwrap();
    assert_eq!(hidden.status, ReviewStatus::Hidden);
    assert_eq!(hidden.moderation_reason.as_deref(), Some(reason));
    assert!(
        device.public_reviews()["reviews"]
            .as_array()
            .unwrap()
            .iter()
            .all(|review| review["id"] != id)
    );
    device.disconnect_and_check("/api/admin/reviews");
    assert!(matches!(
        device.transport.managed_reviews(None, None),
        Err(TransportError::Unauthorized)
    ));
}

#[test]
#[ignore = "needs the synthetic product from the production smoke test"]
fn native_inventory_round_trips_pack_and_stock_through_the_proxy() {
    let id = env("SOB_TEST_INVENTORY_PRODUCT").parse().unwrap();
    let device = proxy_device();
    let browser = Device::sign_in();
    let query = ProductQuery::new(" SMOKE-PHOTO ", false).unwrap();
    let page = device.transport.inventory_products(&query, 1).unwrap();
    assert_eq!(page.products.len(), 1);
    assert_eq!(page.products[0].id, id);
    let product = device.transport.inventory_product(id).unwrap();
    assert!(product.can_manage);
    assert!(product.package_content.is_none());
    let mut replica = Store::open_in_memory().unwrap();
    sync::pull_all(&mut replica, device.transport.as_ref()).unwrap();
    let previous = replica.live_view_revision(INVENTORY_TOPIC).unwrap();

    let pack = PackageContent::parse("12,50", "ml").unwrap().unwrap();
    let saved = device
        .transport
        .update_inventory_content(id, product.version, Some(&pack))
        .unwrap();
    assert_eq!(saved.stock_on_hand, product.stock_on_hand);
    assert_eq!(saved.stock_reserved, product.stock_reserved);
    let path = format!("/admin/inventory/products/{id}");
    assert_eq!(
        browser.rest_get(&path)["packageContent"],
        json!({"quantity": "12.5", "unit": "ml"})
    );
    sync::pull_all(&mut replica, device.transport.as_ref()).unwrap();
    assert!(replica.live_view_revision(INVENTORY_TOPIC).unwrap() > previous);
    assert!(matches!(
        device
            .transport
            .update_inventory_content(id, product.version, None),
        Err(ContentWriteError::Conflict)
    ));

    let mut change = ureq::patch(&format!("{}/api{path}", browser.base))
        .header("Cookie", &browser.cookie)
        .header("Origin", &browser.base)
        .content_type("application/json")
        .send(
            json!({"version": saved.version, "packageContent": {"quantity":"3","unit":"pzs."}})
                .to_string(),
        )
        .unwrap();
    assert_eq!(change.status().as_u16(), 200);
    let _ = change.body_mut().read_to_string().unwrap();
    let refreshed = device.transport.inventory_product(id).unwrap();
    assert_eq!(
        refreshed.package_content,
        PackageContent::parse("3", "pzs.").unwrap()
    );
    assert_eq!(refreshed.stock_on_hand, product.stock_on_hand);
    assert_eq!(refreshed.stock_reserved, product.stock_reserved);
    let cleared = device
        .transport
        .update_inventory_content(id, refreshed.version, None)
        .unwrap();
    assert!(cleared.package_content.is_none());
    assert!(browser.rest_get(&path)["packageContent"].is_null());
    device.assert_inventory_patch_scope(&path, cleared.version);

    let delivery =
        PendingStock::prepare(&cleared, StockKind::Receive, "3", "Desktop delivery").unwrap();
    let stale_count =
        PendingStock::prepare(&cleared, StockKind::Count, "1", "Stale stock count").unwrap();
    let pending_dir = tempfile::tempdir().unwrap();
    let pending_path = pending_dir.path().join("inventory.sqlite");
    let local = Store::open(&pending_path).unwrap();
    assert!(local.reserve_pending_stock(&delivery).unwrap());
    assert!(!local.reserve_pending_stock(&stale_count).unwrap());
    let first = device.transport.move_inventory_stock(&delivery).unwrap();
    assert_eq!(first.stock_on_hand, cleared.stock_on_hand + 3);
    drop(local); // The server may have committed, but the app has not acknowledged its response.

    let local = Store::open(&pending_path).unwrap();
    let recovered = local.pending_stock(id).unwrap().unwrap();
    assert_eq!(recovered, delivery);
    assert_eq!(
        device
            .transport
            .move_inventory_stock(&recovered)
            .unwrap()
            .version,
        first.version
    );
    assert!(local.clear_pending_stock(&recovered).unwrap());

    assert!(matches!(
        device.transport.move_inventory_stock(&stale_count),
        Err(StockWriteError::Conflict)
    ));
    let mut obsolete =
        PendingStock::prepare(&first, StockKind::Count, "1", "Previous history count").unwrap();
    obsolete.command.generation = format!("old-{}", uuid::Uuid::now_v7());
    assert!(matches!(
        device.transport.move_inventory_stock(&obsolete),
        Err(StockWriteError::Transport(
            TransportError::ReplicaGenerationChanged
        ))
    ));

    let usage = PendingStock::prepare(&first, StockKind::Consume, "1", "Desktop usage").unwrap();
    let used = device.transport.move_inventory_stock(&usage).unwrap();
    let count =
        PendingStock::prepare(&used, StockKind::Count, "1", "Confirmed physical count").unwrap();
    assert_eq!(
        device
            .transport
            .move_inventory_stock(&count)
            .unwrap()
            .stock_on_hand,
        1
    );
    assert_eq!(browser.rest_get(&path)["stockOnHand"], 1);
    let movements = device.transport.inventory_movements(id, 1).unwrap();
    assert_eq!(
        movements
            .movements
            .iter()
            .filter(|entry| entry.reason == "Desktop delivery")
            .count(),
        1
    );
    assert_eq!(
        movements
            .movements
            .iter()
            .filter(|entry| matches!(
                entry.kind,
                StockKind::Receive | StockKind::Consume | StockKind::Count
            ))
            .count(),
        3
    );
    assert!(local.reserve_pending_stock(&count).unwrap());
    assert!(!local.clear_pending_stock(&recovered).unwrap());
    assert_eq!(local.pending_stock(id).unwrap(), Some(count));
    let ledger_path = "/admin/inventory/movements";
    let query = LedgerQuery::new(" Desktop ", Some(StockKind::Receive)).unwrap();
    let ledger = device.transport.inventory_ledger(&query, 1).unwrap();
    let web_ledger = browser.rest_get(&format!("{ledger_path}?search=Desktop&kind=receive"));
    assert_eq!(ledger.pagination.total, 1);
    assert_eq!(
        ledger.pagination.total,
        web_ledger["pagination"]["total"].as_u64().unwrap()
    );
    let [delivery] = ledger.movements.as_slice() else {
        panic!("expected one delivery after replay");
    };
    assert_eq!(
        delivery.movement.id.to_string(),
        web_ledger["movements"][0]["id"].as_str().unwrap()
    );
    assert_eq!(delivery.movement.product_id, id);
    assert_eq!(delivery.sku, "SMOKE-PHOTO");
    let mut anchored_query = query.clone();
    let anchor = ledger
        .anchor
        .expect("the ledger should anchor the filtered page");
    assert_eq!(web_ledger["anchor"].as_str().unwrap(), anchor);
    anchored_query.anchor = Some(anchor);
    let current = device.transport.inventory_product(id).unwrap();
    let newer =
        PendingStock::prepare(&current, StockKind::Receive, "1", "Newer desktop delivery").unwrap();
    device.transport.move_inventory_stock(&newer).unwrap();
    let pinned = device
        .transport
        .inventory_ledger(&anchored_query, 1)
        .unwrap();
    assert_eq!(pinned.pagination.total, 1);
    assert!(pinned.has_newer);
    assert_eq!(pinned.movements[0].movement.id, delivery.movement.id);
    assert_eq!(
        device
            .transport
            .inventory_ledger(&query, 1)
            .unwrap()
            .pagination
            .total,
        2
    );
    let mut csv = Vec::new();
    device
        .transport
        .write_inventory_ledger_csv(&anchored_query, &mut csv)
        .unwrap();
    let csv = String::from_utf8(csv).unwrap();
    assert_eq!(csv.lines().count(), 2);
    assert!(csv.contains("Desktop delivery") && csv.contains("unit_cost_cents"));
    assert!(!csv.contains("Desktop usage"));
    assert!(!csv.contains("Newer desktop delivery"));
    device.assert_inventory_ledger_is_read_only();
    device.disconnect_and_check(&format!("/api{ledger_path}"));
    assert!(matches!(
        device.transport.inventory_ledger(&query, 1),
        Err(TransportError::Unauthorized),
    ));
}

impl Device {
    fn sign_in() -> Self {
        let base = env("SOB_TEST_API_URL");
        let auth = Arc::new(BetterAuthSession::new(&base));
        // Each replica still has its own SQLite file, device ID and transport. Reuse the
        // owner's session so adding scenarios does not exhaust the production login limit.
        static SESSION: OnceLock<sob_core::auth::Session> = OnceLock::new();
        let session = SESSION
            .get_or_init(|| {
                auth.sign_in(&Credentials {
                    email: env("SOB_TEST_EMAIL"),
                    password: env("SOB_TEST_PASSWORD"),
                })
                .expect("sign in against the real API")
            })
            .clone();
        let cookie = session.cookie.clone();
        let handle: SessionHandle = Arc::new(RwLock::new(Some(session)));
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("replica.db");
        Self {
            store: Store::open(&path).unwrap(),
            transport: Arc::new(HttpTransport::new(&base, handle, auth)),
            base,
            cookie,
            _dir: dir,
            path,
        }
    }

    fn sync(&mut self) -> sync::CycleReport {
        sync::sync_cycle(&mut self.store, &*self.transport)
            .expect("sync cycle against the real API")
    }

    fn rest_get(&self, path: &str) -> serde_json::Value {
        let prefix = std::env::var("SOB_TEST_REST_PREFIX").unwrap_or_default();
        let mut resp = ureq::get(&format!("{}{prefix}{path}", self.base))
            .header("Cookie", &self.cookie)
            .call()
            .unwrap();
        serde_json::from_str(&resp.body_mut().read_to_string().unwrap()).unwrap()
    }

    #[track_caller]
    fn rest_post(&self, path: &str, body: serde_json::Value) -> serde_json::Value {
        let prefix = std::env::var("SOB_TEST_REST_PREFIX").unwrap_or_default();
        let mut resp = ureq::post(&format!("{}{prefix}{path}", self.base))
            .header("Cookie", &self.cookie)
            .header("Content-Type", "application/json")
            .send(body.to_string())
            .unwrap();
        serde_json::from_str(&resp.body_mut().read_to_string().unwrap()).unwrap()
    }
}

#[test]
#[ignore = "needs the real API, Postgres and Valkey (see README)"]
fn the_native_team_week_matches_the_server_after_sync_and_reopens_offline() {
    let mut desktop = Device::sign_in();
    desktop.sync();
    let staff = desktop.store.staff().unwrap()[0].id.clone();
    let timezone = salon_tz(&desktop.store).unwrap();
    let date = Utc::now().with_timezone(&timezone).date_naive() + Span::days(19);
    let path = format!("/admin/staff/{staff}/date-shifts");
    let selection = json!({"mode":"edit", "changes":[{"date":date.to_string(), "ranges":[{"startTime":"11:00", "endTime":"16:00"}]}]});
    let review = desktop.rest_post(&format!("{path}/preview"), selection.clone());
    desktop.rest_post(&path, json!({"selection":selection, "reviewHash":review["reviewHash"], "idempotencyKey":uuid::Uuid::now_v7().to_string()}));
    let (start, end) = calendar::local_day_range(timezone, date);
    desktop.rest_post(&format!("/admin/staff/{staff}/time-off"), json!({"startsAt":start.to_rfc3339(), "endsAt":end.to_rfc3339(), "reason":"Synthetic private reason"}));
    desktop.sync();

    let reopened = Store::open(&desktop.path).unwrap();
    let offline = sob_core::team_shifts::team_week(&reopened, date).unwrap();
    let published = desktop.rest_get(&format!("/admin/staff/team-shifts?week={}", offline.week));
    let column = date.weekday().num_days_from_monday() as usize;
    let native = offline
        .members
        .iter()
        .find(|member| member.id == staff)
        .unwrap();
    let web = published["members"]
        .as_array()
        .unwrap()
        .iter()
        .find(|member| member["id"] == staff)
        .unwrap();
    assert_eq!(native.days[column].ranges[0].start_time, "11:00");
    assert_eq!(
        native.days[column].ranges[0].start_time,
        web["days"][column]["ranges"][0]["startTime"]
            .as_str()
            .unwrap()
    );
    assert!(native.days[column].custom && native.days[column].absences[0].full_day);
    assert!(!native.days[column].absences[0].pending);
    assert_eq!(web["days"][column]["absences"][0]["fullDay"], true);
}

struct Catalog {
    staff: String,
    other_staff: String,
    haircut: String,
}

fn catalog(d: &Device) -> Catalog {
    let staff = d.store.staff().unwrap();
    assert!(staff.len() >= 2, "the seed has two stylists, got {staff:?}");
    let haircut = d
        .store
        .services()
        .unwrap()
        .into_iter()
        .find(|s| s.name == "Haircut")
        .expect("seeded Haircut");
    Catalog {
        staff: staff[0].id.clone(),
        other_staff: staff[1].id.clone(),
        haircut: haircut.id,
    }
}

fn jitter(modulo: u64) -> u64 {
    let b = uuid::Uuid::now_v7().into_bytes();
    u64::from_le_bytes(b[8..16].try_into().unwrap()) % modulo
}

/// A free 60-minute slot, with 2 more free hours after it, inside the staff member's working
/// hours, a few days from now (after the minimum-notice window, before the advance limit).
fn free_slot(d: &Device, staff_id: &str) -> DateTime<Utc> {
    free_slot_matching(d, staff_id, |_| true)
}

fn free_slot_matching(
    d: &Device,
    staff_id: &str,
    matches_fixture: impl Fn(DateTime<Utc>) -> bool,
) -> DateTime<Utc> {
    let tz = salon_tz(&d.store).unwrap();
    let hours = d.store.working_hours().unwrap();
    // Earlier scenarios leave real date overrides behind. This helper picks weekly hours only.
    let overrides: std::collections::HashSet<_> = d
        .store
        .date_shifts()
        .unwrap()
        .into_iter()
        .filter(|shift| shift.staff_id == staff_id && shift.ranges.is_some())
        .map(|shift| shift.date)
        .collect();
    for _ in 0..200 {
        let day = (Utc::now() + Span::days(4 + jitter(40) as i64))
            .with_timezone(&tz)
            .date_naive();
        if overrides.contains(&day.to_string()) {
            continue;
        }
        let weekday = day.weekday().num_days_from_sunday() as i64;
        let Some(h) = hours
            .iter()
            .find(|h| h.staff_id == staff_id && h.weekday == weekday)
        else {
            continue;
        };
        let start = NaiveTime::parse_from_str(&h.start_time[..5], "%H:%M").unwrap();
        let end = NaiveTime::parse_from_str(&h.end_time[..5], "%H:%M").unwrap();
        let room_min = (end - start).num_minutes() - 180;
        if room_min < 0 {
            continue;
        }
        let at = start + Span::minutes(15 * jitter(room_min as u64 / 15 + 1) as i64);
        let t = tz
            .from_local_datetime(&day.and_time(at))
            .single()
            .unwrap()
            .with_timezone(&Utc);
        let busy = d
            .store
            .appointments_between(
                (t - Span::hours(1)).timestamp_millis(),
                (t + Span::hours(3)).timestamp_millis(),
            )
            .unwrap()
            .iter()
            .any(|a| a.staff_id == staff_id && a.status != AppointmentStatus::Cancelled);
        if !busy && matches_fixture(t) {
            return t;
        }
    }
    panic!("no free slot found; clean the test database");
}

fn booking(c: &Catalog, staff: &str, client: &str, at: DateTime<Utc>) -> NewAppointment {
    NewAppointment {
        staff_id: staff.into(),
        service_ids: vec![c.haircut.clone()],
        starts_at: at,
        client_id: client.into(),
        notes: Some("headless sync test".into()),
        override_notice: false,
    }
}

fn day_items(d: &Device, at: DateTime<Utc>, staff: &str) -> Vec<calendar::CalendarItem> {
    let tz = salon_tz(&d.store).unwrap();
    let view = calendar::day_view(&d.store, at.with_timezone(&tz).date_naive()).unwrap();
    view.columns
        .into_iter()
        .find(|c| c.staff.id == staff)
        .map(|c| c.items)
        .unwrap_or_default()
}

fn eur_booking(desk: &mut Device, price: u32, discount: Option<u32>) -> Appointment {
    desk.sync();
    let catalog = catalog(desk);
    let starts_at = free_slot(desk, &catalog.staff);
    let client = if let Some(discount) = discount {
        let id = uuid::Uuid::now_v7().to_string();
        let saved = desk.rest_post(
            "/admin/clients",
            json!({
                "id": id, "name": "Synthetic cash client",
                "contactDetails": { "discountBasisPoints": discount },
            }),
        );
        assert_eq!(saved["id"], id);
        id
    } else {
        ops::create_client(&mut desk.store, "Synthetic settlement", None).unwrap()
    };
    let service = desk.rest_post(
        "/admin/services",
        json!({
            "name": "Settlement fixture",
            "durationMinutes": 45,
            "bufferMinutes": 15,
            "priceCents": price,
            "currency": "EUR",
            "staffIds": [catalog.staff],
        }),
    );
    let mut input = booking(&catalog, &catalog.staff, &client, starts_at);
    input.service_ids = vec![service["id"].as_str().unwrap().to_owned()];
    desk.sync();
    let id = ops::create_appointment(&mut desk.store, input).unwrap();
    desk.sync();
    desk.store.appointment(&id).unwrap().unwrap()
}

fn imported_eur_booking(desk: &mut Device, price: u32) -> Appointment {
    let appointment = eur_booking(desk, price, None);
    let id = appointment.id;
    let annotations = json!({
        "rows": [{
            "appointmentId": id,
            "appointmentVersion": appointment.version,
            "contextVersion": 0,
            "servicePosition": 0,
            "requestedStaffId": appointment.staff_id,
            "internalNote": "Synthetic private internal note",
            "customerComment": "Synthetic private customer comment",
            "invoiced": true,
            "paid": true,
            "sourceRef": format!("synthetic-{id}"),
        }],
    });
    let review = desk.rest_post("/appointments/booksy-context/preview", annotations.clone());
    desk.rest_post(
        "/appointments/booksy-context/import",
        json!({ "input": annotations, "reviewHash": review["reviewHash"] }),
    );
    desk.sync();
    desk.store.appointment(&id).unwrap().unwrap()
}

#[test]
#[ignore = "needs the real API behind the web gateway (see README)"]
fn native_walk_in_sale_replays_and_updates_web_stock_through_the_proxy() {
    let browser = Device::sign_in();
    let product = browser.rest_post(
        "/admin/inventory/products",
        json!({
            "name": "Synthetic walk-in product",
            "sku": "SMOKE-WALK-IN",
            "idempotencyKey": uuid::Uuid::now_v7(),
            "openingStock": 3,
            "priceCents": 2000,
            "unitLabel": "unit",
            "resellable": true,
        }),
    );
    let product_id = uuid::Uuid::parse_str(product["id"].as_str().unwrap()).unwrap();
    let device = proxy_device();
    let query = ProductQuery::new("SMOKE-WALK-IN", false).unwrap();
    assert!(
        device
            .transport
            .products_for_sale(&query, 1)
            .unwrap()
            .products
            .iter()
            .any(|p| p.id == product_id)
    );
    let before = device.transport.inventory_product(product_id).unwrap();
    assert!(device.transport.can_assign_walk_in_sales().unwrap());
    let mut staff_lookup = Device::sign_in();
    staff_lookup.sync();
    let staff_id: uuid::Uuid = catalog(&staff_lookup).staff.parse().unwrap();
    let sale = WalkInSale {
        idempotency_key: uuid::Uuid::now_v7(),
        client_id: None,
        staff_id: Some(staff_id),
        use_client_discount: None,
        lines: vec![
            SaleItem::Product {
                product_id,
                quantity: 2,
            },
            SaleItem::Custom {
                description: "Synthetic extra".into(),
                unit_amount_cents: 500,
                quantity: 1,
            },
        ],
        discount_cents: 400,
        tip_cents: 100,
    };
    let receipt = device.transport.create_walk_in_sale(&sale).unwrap();
    assert!(receipt.appointment_id.is_none());
    assert_eq!(receipt.total_cents, 4200);
    assert_eq!(
        device.transport.create_walk_in_sale(&sale).unwrap().id,
        receipt.id
    );
    let paid = device
        .transport
        .record_checkout_payment(
            &receipt,
            &PaymentAttempt::new(ReceiptTender::ExternalCard, 4200),
        )
        .unwrap();
    assert_eq!(paid.status, "paid");
    let web = browser.rest_get(&format!("/admin/commerce/checkouts/{}", receipt.id));
    assert_eq!(web["paidCents"], 4200);
    assert_eq!(web["staffId"], staff_id.to_string());
    let history = device
        .transport
        .checkout_history(
            &sob_core::billing::CheckoutHistoryFilters {
                search: "Synthetic walk-in product".into(),
                status: Some("paid"),
                method: Some("external_card"),
                ..Default::default()
            },
            1,
        )
        .unwrap();
    let saved = history
        .checkouts
        .iter()
        .find(|sale| sale.id.to_string() == receipt.id)
        .unwrap();
    assert_eq!(saved.status, "paid");
    assert_eq!(
        device
            .transport
            .open_saved_checkout(saved.id)
            .unwrap()
            .paid_cents,
        4200
    );
    let after = device.transport.inventory_product(product_id).unwrap();
    assert_eq!(after.stock_on_hand, before.stock_on_hand - 2);
    assert_eq!(after.stock_reserved, 0);

    let unpaid = WalkInSale {
        idempotency_key: uuid::Uuid::now_v7(),
        lines: vec![SaleItem::Product {
            product_id,
            quantity: 1,
        }],
        discount_cents: 0,
        tip_cents: 0,
        ..sale.clone()
    };
    let open = device.transport.create_walk_in_sale(&unpaid).unwrap();
    assert_eq!(
        device
            .transport
            .inventory_product(product_id)
            .unwrap()
            .stock_reserved,
        1
    );
    let voided = device.transport.void_checkout(&open).unwrap();
    assert_eq!(voided.status, "void");
    assert_eq!(device.transport.void_checkout(&open).unwrap().id, voided.id);
    assert_eq!(
        device
            .transport
            .inventory_product(product_id)
            .unwrap()
            .stock_reserved,
        0
    );

    let payment = paid.recordable_refunds_available().next().unwrap();
    let refund = sob_core::billing::RefundAttempt::new(1200, "Synthetic partial return").unwrap();
    let updated = device
        .transport
        .record_checkout_refund(&paid, payment.id, &refund)
        .unwrap();
    assert_eq!(updated.status, "partially_refunded");
    assert_eq!(
        updated
            .recordable_refunds_available()
            .next()
            .unwrap()
            .available,
        3000
    );
    let replayed = device
        .transport
        .record_checkout_refund(&paid, payment.id, &refund)
        .unwrap();
    assert_eq!(replayed.refunds.len(), 1);
    let web = browser.rest_get(&format!("/admin/commerce/checkouts/{}", receipt.id));
    assert_eq!(web["refundedCents"], 1200);
    assert_eq!(
        device
            .transport
            .inventory_product(product_id)
            .unwrap()
            .stock_on_hand,
        before.stock_on_hand - 2
    );
    let line = updated.returnable_products().next().unwrap();
    let actor = browser.rest_get("/me")["user"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let attempt = updated
        .stock_return(line.id, 1, "Synthetic returned product", actor)
        .unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let replica = scratch.path().join("stock-return.db");
    let receipt_id = updated.id.parse().unwrap();
    let actor_id = browser.rest_get("/me")["user"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(
        Store::open(&replica)
            .unwrap()
            .reserve_stock_return(&attempt)
            .unwrap()
    );
    // The first write may commit before Desktop can record its acknowledgement.
    device.transport.return_inventory_stock(&attempt).unwrap();
    let persisted = Store::open(&replica).unwrap();
    assert!(!persisted.reserve_stock_return(&attempt).unwrap());
    let attempt = persisted
        .pending_stock_return(receipt_id, &actor_id)
        .unwrap()
        .unwrap();
    let stock = device.transport.return_inventory_stock(&attempt).unwrap();
    assert_eq!(stock.stock_on_hand, before.stock_on_hand - 1);
    assert_eq!(
        device
            .transport
            .return_inventory_stock(&attempt)
            .unwrap()
            .stock_on_hand,
        stock.stock_on_hand
    );
    persisted.clear_stock_return(&attempt).unwrap();
    assert!(
        persisted
            .pending_stock_return(receipt_id, &actor_id)
            .unwrap()
            .is_none()
    );
    let current = browser.rest_get(&format!("/admin/commerce/checkouts/{}", receipt.id));
    assert_eq!(current["refundedCents"], 1200);
    let cloud_stock = browser.rest_get(&format!("/admin/inventory/products/{product_id}"));
    assert_eq!(cloud_stock["stockOnHand"], before.stock_on_hand - 1);
}

#[test]
#[ignore = "requires smoke stack"]
fn native_gift_card_redemption_and_refund_update_cloud_balance_once() {
    use sob_core::billing::{SaleItem, WalkInSale};

    let browser = Device::sign_in();
    let gift = browser.rest_post(
        "/admin/gift-cards",
        json!({"amountCents": 2000, "idempotencyKey": uuid::Uuid::now_v7()}),
    );
    let gift_id = gift["card"]["id"].as_str().unwrap();
    let purchase_id = gift["checkout"]["id"].as_str().unwrap();
    browser.rest_post(
        &format!("/admin/commerce/checkouts/{purchase_id}/payments"),
        json!({"method":"external_card","amountCents":2000,"idempotencyKey":uuid::Uuid::now_v7()}),
    );
    let revealed = browser.rest_post(&format!("/admin/gift-cards/{gift_id}/code"), json!({}));
    let code = revealed["code"].as_str().unwrap();
    let attempt = PaymentAttempt::with_gift_card(1200, &code.to_lowercase()).unwrap();
    let device = proxy_device();
    let receipt = device
        .transport
        .create_walk_in_sale(&WalkInSale {
            idempotency_key: uuid::Uuid::now_v7(),
            client_id: None,
            staff_id: None,
            use_client_discount: None,
            lines: vec![SaleItem::Custom {
                description: "Synthetic gift card redemption".into(),
                unit_amount_cents: 1800,
                quantity: 1,
            }],
            discount_cents: 0,
            tip_cents: 0,
        })
        .unwrap();
    let updated = device
        .transport
        .record_checkout_payment(&receipt, &attempt)
        .unwrap();
    assert_eq!(updated.paid_cents, 1200);
    assert_eq!(updated.collectible_cents(), 600);
    assert_eq!(
        device
            .transport
            .record_checkout_payment(&receipt, &attempt)
            .unwrap()
            .paid_cents,
        1200
    );
    let paid = device
        .transport
        .record_checkout_payment(
            &updated,
            &PaymentAttempt::new(ReceiptTender::ExternalCard, 600),
        )
        .unwrap();
    assert_eq!(paid.status, "paid");
    let cloud = browser.rest_get(&format!("/admin/gift-cards/{gift_id}"));
    assert_eq!(cloud["balanceCents"], 800);
    let cloud = browser.rest_get(&format!("/admin/commerce/checkouts/{}", receipt.id));
    assert_eq!(cloud["payments"].as_array().unwrap().len(), 2);
    assert_eq!(cloud["paidCents"], 1800);
    let gift_payment = paid
        .recordable_refunds_available()
        .find(|payment| {
            payment.tender == sob_core::billing::RefundTender::Manual(ReceiptTender::GiftCard)
        })
        .unwrap();
    let refund = sob_core::billing::RefundAttempt::new(300, "Synthetic gift card refund").unwrap();
    let returned = device
        .transport
        .record_checkout_refund(&paid, gift_payment.id, &refund)
        .unwrap();
    assert_eq!(returned.status, "partially_refunded");
    assert_eq!(
        device
            .transport
            .record_checkout_refund(&paid, gift_payment.id, &refund)
            .unwrap()
            .refunds
            .len(),
        1
    );
    let cloud = browser.rest_get(&format!("/admin/gift-cards/{gift_id}"));
    assert_eq!(cloud["balanceCents"], 1100);
}

#[test]
#[ignore = "needs the real API behind the web gateway (see README)"]
fn native_redeems_and_restores_the_reviewed_pass_visit_once() {
    let mut browser = Device::sign_in();
    browser.sync();
    let catalog = catalog(&browser);
    let slot = free_slot(&browser, &catalog.staff);
    let client = ops::create_client(&mut browser.store, "Synthetic pass customer", None).unwrap();
    let service = browser.rest_post(
        "/admin/services",
        json!({
            "name": "Synthetic service eligible for the pass",
            "durationMinutes": 30,
            "priceCents": 3500,
            "currency": "EUR",
            "staffIds": [catalog.staff],
        }),
    );
    let service_id = service["id"].as_str().unwrap();
    browser.sync();
    let plan = browser.rest_post(
        "/admin/benefit-plans",
        json!({
            "name": "Synthetic three visits",
            "kind": "package",
            "priceCents": 3000,
            "includedUses": 3,
            "serviceIds": [service_id],
            "idempotencyKey": uuid::Uuid::now_v7(),
        }),
    );
    let purchase = browser.rest_post(
        "/admin/passes",
        json!({
            "planId": plan["id"],
            "clientId": client,
            "idempotencyKey": uuid::Uuid::now_v7(),
        }),
    );
    let purchase_id = purchase["checkout"]["id"].as_str().unwrap();
    browser.rest_post(
        &format!("/admin/commerce/checkouts/{purchase_id}/payments"),
        json!({"method":"external_card","amountCents":3000,"idempotencyKey":uuid::Uuid::now_v7()}),
    );
    let mut input = booking(&catalog, &catalog.staff, &client, slot);
    input.service_ids = vec![service_id.to_owned()];
    let appointment = ops::create_appointment(&mut browser.store, input).unwrap();
    browser.sync();
    let linked = proxy_device();
    let checkout = linked
        .transport
        .open_appointment_checkout(&appointment, None)
        .unwrap();
    let choices = linked
        .transport
        .eligible_checkout_passes(&checkout)
        .unwrap();
    let [choice] = choices.as_slice() else {
        panic!("expected one eligible service and pass, got {choices:?}");
    };
    assert_eq!(choice.kind, ReceiptTender::Package);
    assert_eq!(choice.amount_cents, checkout.collectible_cents());
    let attempt = PaymentAttempt::for_pass(choice);
    let paid = linked
        .transport
        .record_checkout_payment(&checkout, &attempt)
        .unwrap();
    assert_eq!(paid.status, "paid");
    assert_eq!(
        linked
            .transport
            .record_checkout_payment(&checkout, &attempt)
            .unwrap()
            .id,
        paid.id
    );
    let pass = browser.rest_get(&format!(
        "/admin/passes/{}",
        purchase["pass"]["id"].as_str().unwrap()
    ));
    assert_eq!(pass["periods"][0]["availableUses"], 2);
    assert_eq!(pass["periods"][0]["usedUses"], 1);

    let payment = paid.recordable_refunds_available().next().unwrap();
    assert!(payment.is_full_visit());
    let invalid =
        sob_core::billing::RefundAttempt::new(payment.available - 1, "Partial pass refund")
            .unwrap();
    assert!(matches!(
        linked
            .transport
            .record_checkout_refund(&paid, payment.id, &invalid),
        Err(TransportError::BadRequest(_))
    ));
    let refund =
        sob_core::billing::RefundAttempt::new(payment.available, "Restore visit to pass").unwrap();
    let refunded = linked
        .transport
        .record_checkout_refund(&paid, payment.id, &refund)
        .unwrap();
    assert_eq!(refunded.status, "refunded");
    assert_eq!(
        linked
            .transport
            .record_checkout_refund(&paid, payment.id, &refund)
            .unwrap()
            .refunds
            .len(),
        1
    );
    let pass = browser.rest_get(&format!(
        "/admin/passes/{}",
        purchase["pass"]["id"].as_str().unwrap()
    ));
    assert_eq!(pass["periods"][0]["availableUses"], 3);
    assert_eq!(pass["periods"][0]["usedUses"], 0);

    let receipt = linked
        .transport
        .open_saved_checkout(purchase_id.parse().unwrap())
        .unwrap();
    let payment = receipt.recordable_refunds_available().next().unwrap();
    let quote = linked
        .transport
        .quote_pass_refund(&receipt, payment.id, 2)
        .unwrap();
    assert_eq!(quote.amount_cents, 2000);
    let attempt = sob_core::billing::RefundAttempt::from_pass_quote(
        &quote,
        "Return two unused visits",
        payment.pass_period_id.unwrap(),
        receipt.refund_review_generation.clone().unwrap(),
    )
    .unwrap();
    let result = linked
        .transport
        .record_checkout_refund(&receipt, payment.id, &attempt)
        .unwrap();
    assert_eq!(result.refunded_cents, 2000);
    assert_eq!(
        linked
            .transport
            .record_checkout_refund(&receipt, payment.id, &attempt)
            .unwrap()
            .refunds
            .len(),
        1
    );
    let pass = browser.rest_get(&format!(
        "/admin/passes/{}",
        purchase["pass"]["id"].as_str().unwrap()
    ));
    assert_eq!(pass["periods"][0]["availableUses"], 1);
    assert_eq!(pass["periods"][0]["returnedUses"], 2);
}

#[test]
#[ignore = "needs the real API behind the web gateway (see README)"]
fn native_finalizes_a_pending_service_price_through_the_proxy() {
    let mut browser = Device::sign_in();
    browser.sync();
    let catalog = catalog(&browser);
    let starts_at = free_slot(&browser, &catalog.staff);
    let client = ops::create_client(&mut browser.store, "Synthetic pricing client", None).unwrap();
    let service = browser.rest_post(
        "/admin/services",
        json!({
            "name": "Synthetic service with minimum price",
            "durationMinutes": 45,
            "priceType": "from",
            "priceCents": 3000,
            "currency": "EUR",
            "staffIds": [catalog.staff],
        }),
    );
    browser.sync();
    let mut input = booking(&catalog, &catalog.staff, &client, starts_at);
    input.service_ids = vec![service["id"].as_str().unwrap().to_owned()];
    let id = ops::create_appointment(&mut browser.store, input).unwrap();
    browser.sync();

    let device = proxy_device();
    let receipt = device
        .transport
        .open_appointment_checkout(&id, None)
        .unwrap();
    assert!(receipt.can_review_prices());
    assert_eq!(receipt.collectible_cents(), 0);
    let line = receipt
        .lines
        .iter()
        .find(|line| line.price_pending)
        .unwrap();
    assert_eq!(line.minimum_unit_amount_cents, 3000);
    let reviewed = CheckoutFinalPrice {
        id: line.id,
        unit_amount_cents: 7550,
    };
    let below_minimum = CheckoutFinalPrice {
        id: line.id,
        unit_amount_cents: 2999,
    };
    assert!(matches!(
        device
            .transport
            .finalize_checkout_prices(&receipt, &[below_minimum]),
        Err(TransportError::BadRequest(_))
    ));
    let prices = std::slice::from_ref(&reviewed);
    let confirmed = device
        .transport
        .finalize_checkout_prices(&receipt, prices)
        .unwrap();
    assert_eq!(confirmed.collectible_cents(), 7550);
    assert!(!confirmed.can_review_prices());
    assert!(matches!(
        device.transport.finalize_checkout_prices(&receipt, prices),
        Err(TransportError::BadRequest(_))
    ));
    let paid = device
        .transport
        .record_checkout_payment(
            &confirmed,
            &PaymentAttempt::new(ReceiptTender::ExternalCard, 7550),
        )
        .unwrap();
    assert_eq!(paid.status, "paid");
    let web = browser.rest_get(&format!("/admin/commerce/checkouts/{}", paid.id));
    assert_eq!(web["paidCents"], 7550);
    assert_eq!(web["lines"][0]["pricePending"], false);
}

#[test]
#[ignore = "needs the real API, Postgres and Valkey (see README)"]
fn native_appointment_receipt_applies_the_profile_discount_and_records_split_tenders() {
    let mut desk = Device::sign_in();
    let booking = eur_booking(&mut desk, 10000, Some(1250));
    let receipt = desk
        .transport
        .open_appointment_checkout(&booking.id, None)
        .unwrap();
    assert_eq!(receipt.discount_cents, 1250);
    assert_eq!(receipt.total_cents, 8750);
    assert_eq!(receipt.collectible_cents(), 8750);
    let open = CashCommand::open(5000);
    let register = desk.transport.update_cash_session(&open).unwrap();
    assert_eq!(
        desk.transport.update_cash_session(&open).unwrap().id,
        register.id
    );
    let cash = PaymentAttempt::new(ReceiptTender::Cash, 3000);
    let adjusted = desk
        .transport
        .record_checkout_payment(&receipt, &cash)
        .unwrap();
    assert_eq!(adjusted.paid_cents, 3000);
    assert_eq!(adjusted.collectible_cents(), 5750);
    assert_eq!(
        desk.transport
            .record_checkout_payment(&receipt, &cash)
            .unwrap()
            .paid_cents,
        3000
    );
    let card = PaymentAttempt::new(ReceiptTender::ExternalCard, 5750);
    let paid = desk
        .transport
        .record_checkout_payment(&adjusted, &card)
        .unwrap();
    assert_eq!(paid.status, "paid");
    assert_eq!(paid.paid_cents, 8750);
    assert!(
        desk.transport
            .update_cash_session(&CashCommand::close(&register, 5000))
            .is_err()
    );
    let current = desk.transport.current_cash_session().unwrap().unwrap();
    assert_eq!(current.expected_cents, 8000);
    let deposit = CashCommand::adjust(
        &current,
        CashAdjustment::Deposit,
        1000,
        "Synthetic float".into(),
    );
    let deposited = desk.transport.update_cash_session(&deposit).unwrap();
    assert_eq!(deposited.expected_cents, 9000);
    assert_eq!(
        desk.transport
            .update_cash_session(&deposit)
            .unwrap()
            .expected_cents,
        9000
    );
    let withdrawal = CashCommand::adjust(
        &deposited,
        CashAdjustment::Withdrawal,
        300,
        "Synthetic withdrawal".into(),
    );
    let remaining = desk.transport.update_cash_session(&withdrawal).unwrap();
    assert_eq!(remaining.expected_cents, 8700);
    let counted = desk
        .transport
        .update_cash_session(&CashCommand::close(&remaining, 8600))
        .unwrap();
    assert_eq!(counted.expected_cents, 8700);
    assert_eq!(counted.difference_cents, Some(-100));
    let from_web = desk.rest_get("/admin/commerce/cash-sessions/current");
    assert_eq!(from_web["session"]["id"], counted.id.to_string());
    assert_eq!(from_web["session"]["differenceCents"], -100);
    assert_eq!(
        from_web["session"]["movements"].as_array().unwrap().len(),
        3
    );
    assert_eq!(desk.store.outbox_len().unwrap(), 0);
}

#[test]
#[ignore = "needs the real API, Postgres and Valkey (see README)"]
fn imported_settlement_replays_safely_and_reopens_offline() {
    let mut desk = Device::sign_in();
    let price = 3650;
    let before = imported_eur_booking(&mut desk, price);
    let id = before.id.clone();
    assert!(!before.externally_settled);
    assert!(
        before
            .billing_review_reasons
            .contains(&BillingReviewReason::PaidInBooksy)
    );
    let status = desk.transport.imported_settlement_status(&id).unwrap();
    assert_eq!(status.appointment_version, before.version);
    assert!(status.settlement.is_none());
    let payload = ImportedSettlement {
        appointment_version: status.appointment_version,
        amount_cents: price,
        reference: "Synthetic verified external receipt".to_owned(),
    };
    assert_eq!(
        desk.transport
            .confirm_imported_settlement(&id, &payload)
            .unwrap(),
        price
    );
    assert_eq!(
        desk.transport
            .confirm_imported_settlement(&id, &payload)
            .unwrap(),
        price
    );
    assert_eq!(desk.store.outbox_len().unwrap(), 0);
    desk.sync();
    let wire = desk.rest_get("/sync/pull?since=0&limit=500");
    assert!(!wire.to_string().contains(&payload.reference));

    let offline = Store::open(&desk.path).unwrap();
    let settled = offline.appointment(&id).unwrap().unwrap();
    assert!(settled.externally_settled);
    assert_eq!(settled.version, before.version + 1);
    assert!(
        !serde_json::to_string(&settled)
            .unwrap()
            .contains(&payload.reference)
    );
}

#[test]
#[ignore = "needs the real API behind the web gateway (see README)"]
fn native_unpaid_appointments_are_available_to_a_linked_device() {
    let mut owner = Device::sign_in();
    let appointment = imported_eur_booking(&mut owner, 10000);
    let zone = salon_tz(&owner.store).unwrap();
    let date = appointment.starts_at.with_timezone(&zone).date_naive();
    let device = proxy_device();
    let rows = device.transport.unpaid_appointments(date, zone).unwrap();
    assert!(rows.billing_review.iter().any(|item| {
        item.row.id.to_string() == appointment.id
            && item.reasons.contains(&BillingReviewReason::PaidInBooksy)
    }));
}

#[test]
#[ignore = "needs the real API, Postgres and Valkey (see README)"]
fn imported_partial_payment_preserves_the_original_total_and_opens_only_the_balance() {
    let mut desk = Device::sign_in();
    let before = imported_eur_booking(&mut desk, 10000);
    let id = &before.id;
    let zone = salon_tz(&desk.store).unwrap();
    let date = before.starts_at.with_timezone(&zone).date_naive();
    let queue = || desk.transport.unpaid_appointments(date, zone).unwrap();
    let belongs_to_appointment = |row_id: uuid::Uuid| row_id.to_string() == *id;
    assert!(
        queue()
            .billing_review
            .iter()
            .any(|item| belongs_to_appointment(item.row.id))
    );
    assert!(before.imported_from_booksy);
    let annotations = desk.transport.appointment_annotations(id).unwrap();
    assert_eq!(annotations.rows.len(), 1);
    assert_eq!(annotations.rows[0].service_position, 0);
    assert_eq!(
        annotations.rows[0].internal_note.as_deref(),
        Some("Synthetic private internal note")
    );
    assert_eq!(
        annotations.rows[0].customer_comment.as_deref(),
        Some("Synthetic private customer comment")
    );
    let ImportedPartialPaymentPreview::Ready(terms) =
        desk.transport.imported_partial_payment_preview(id).unwrap()
    else {
        panic!("expected unreviewed Booksy terms");
    };
    assert_eq!(terms.appointment_version, before.version);
    assert_eq!(terms.original_total_cents, 10000);
    let payload = ImportedSettlement {
        appointment_version: terms.appointment_version,
        amount_cents: 3500,
        reference: "Synthetic partial payment proof".to_owned(),
    };
    let record = || {
        desk.transport
            .confirm_imported_partial_payment(id, &payload, 10000)
            .unwrap()
    };
    let balance = record();
    assert_eq!(record(), balance);
    assert_eq!(balance.paid_in_booksy_cents, 3500);
    assert_eq!(balance.due_in_citame_cents, 6500);
    let pending = queue();
    assert!(
        !pending
            .billing_review
            .iter()
            .any(|item| belongs_to_appointment(item.row.id))
    );
    assert_eq!(
        pending
            .appointments
            .iter()
            .find(|item| belongs_to_appointment(item.row.id))
            .and_then(|item| item.external_balance),
        Some(balance)
    );
    assert_eq!(desk.store.outbox_len().unwrap(), 0);
    desk.sync();
    let saved = Store::open(&desk.path)
        .unwrap()
        .appointment(id)
        .unwrap()
        .unwrap();
    assert_eq!(saved.external_balance, Some(balance));
    assert_eq!(saved.version, before.version + 1);
    assert_eq!(saved.services[0].price_cents, 10000);
    assert!(
        !serde_json::to_string(&saved)
            .unwrap()
            .contains("Synthetic private")
    );
    assert_eq!(
        saved.service_badges,
        [CalendarServiceBadge {
            service_position: 0,
            requested: true,
            invoiced: true,
            paid: false,
            billing_source: Some(CalendarBillingSource::Booksy),
            internal_note: true,
            customer_comment: true,
        }]
    );
    let wire = desk.rest_get("/sync/pull?since=0&limit=500");
    assert!(!wire.to_string().contains(&payload.reference));
    assert!(!wire.to_string().contains("Synthetic private"));

    let checkout = desk
        .transport
        .open_appointment_checkout(id, Some(balance))
        .unwrap();
    assert_eq!(checkout.total_cents, 6500);
    assert_eq!(checkout.balance_cents, 6500);
    assert_eq!(checkout.paid_cents, 0);
    assert_eq!(checkout.collectible_cents(), 6500);
    let request = PaymentAttempt::new(ReceiptTender::ExternalCard, 6500);
    let record = || {
        desk.transport
            .record_checkout_payment(&checkout, &request)
            .unwrap()
    };
    let receipt = record();
    assert_eq!(receipt.status, "paid");
    assert_eq!(receipt.paid_cents, 6500);
    assert_eq!(receipt.balance_cents, 0);
    assert_eq!(receipt.collectible_cents(), 0);
    assert_eq!(record().paid_cents, 6500);
    assert!(
        !desk
            .transport
            .unpaid_appointments(date, zone)
            .unwrap()
            .appointments
            .iter()
            .any(|item| belongs_to_appointment(item.row.id))
    );
    assert_eq!(
        desk.transport
            .open_appointment_checkout(id, Some(balance))
            .unwrap()
            .id,
        checkout.id
    );
    assert_eq!(desk.store.outbox_len().unwrap(), 0);
    desk.sync();
    let paid = desk.store.appointment(id).unwrap().unwrap();
    assert_eq!(paid.version, saved.version);
    assert!(paid.service_badges[0].paid);
    assert_eq!(
        paid.service_badges[0].billing_source,
        Some(CalendarBillingSource::Citame)
    );

    let current = desk.transport.appointment_annotations(id).unwrap();
    assert_eq!(current.appointment_version, Some(paid.version));
    let updated_note = UpdateServiceAnnotations {
        appointment_version: current.appointment_version.unwrap(),
        service_position: 0,
        version: current.rows[0].version,
        requested: None,
        internal_note: "New private note\nSecond line".to_owned(),
    };
    let confirmed = desk
        .transport
        .update_service_annotations(id, &updated_note)
        .unwrap()
        .unwrap();
    assert_eq!(confirmed.appointment_version, Some(paid.version + 1));
    assert_eq!(
        confirmed.rows[0].internal_note.as_deref(),
        Some(updated_note.internal_note.as_str())
    );
    assert_eq!(
        confirmed.rows[0].customer_comment,
        annotations.rows[0].customer_comment
    );
    assert!(
        desk.transport
            .update_service_annotations(id, &updated_note)
            .unwrap()
            .is_none()
    );
    desk.sync();
    let replicated = desk.store.appointment(id).unwrap().unwrap();
    assert!(replicated.service_badges[0].requested);
    assert!(replicated.service_badges[0].internal_note);
    assert!(
        !serde_json::to_string(&replicated)
            .unwrap()
            .contains("New private note")
    );
    let cleared = desk
        .transport
        .update_service_annotations(
            id,
            &UpdateServiceAnnotations {
                appointment_version: confirmed.appointment_version.unwrap(),
                version: confirmed.rows[0].version,
                requested: Some(false),
                ..updated_note
            },
        )
        .unwrap()
        .unwrap();
    assert_eq!(cleared.rows[0].requested_staff_id, None);
    assert_eq!(
        cleared.rows[0].internal_note,
        confirmed.rows[0].internal_note
    );
    assert_eq!(
        cleared.rows[0].customer_comment,
        confirmed.rows[0].customer_comment
    );
    desk.sync();
    let replica = desk.store.appointment(id).unwrap().unwrap();
    assert!(!replica.service_badges[0].requested);
    assert!(replica.service_badges[0].internal_note);
    let requested = desk
        .transport
        .update_service_annotations(
            id,
            &UpdateServiceAnnotations {
                appointment_version: cleared.appointment_version.unwrap(),
                service_position: 0,
                version: cleared.rows[0].version,
                requested: Some(true),
                internal_note: cleared.rows[0].internal_note.clone().unwrap(),
            },
        )
        .unwrap()
        .unwrap();
    assert_eq!(
        requested.rows[0].requested_staff_id.as_deref(),
        Some(replica.staff_id.as_str())
    );
    desk.sync();
    assert!(desk.store.appointment(id).unwrap().unwrap().service_badges[0].requested);
}

#[test]
#[ignore = "needs the real API, Postgres and Valkey (see README)"]
fn offline_time_off_syncs_and_rejects_a_stale_delete_without_touching_the_booking() {
    let mut a = Device::sign_in();
    let mut b = Device::sign_in();
    a.sync();
    assert_eq!(
        a.store.get_meta("time_off_scope").unwrap().as_deref(),
        Some("all")
    );
    let c = catalog(&a);
    let at = free_slot(&a, &c.staff);
    let end = at + Span::hours(1);
    let client = ops::create_client(&mut a.store, "Block sync fixture", None).unwrap();
    let appt = ops::create_appointment(&mut a.store, booking(&c, &c.staff, &client, at)).unwrap();
    assert_eq!(a.sync().push.applied, 2);

    let id = ops::create_time_off(&mut a.store, &c.staff, at, end, "First").unwrap();
    let read = |device: &Device| {
        calendar::effective_time_off(&device.store, at, end)
            .unwrap()
            .into_iter()
            .find(|block| block.time_off.id == id)
    };
    let created = read(&a).unwrap();
    assert!(created.pending);
    assert!(ops::create_appointment(&mut a.store, booking(&c, &c.staff, &client, at)).is_err());
    ops::update_time_off(&mut a.store, &created.time_off, at, end, "Reviewed").unwrap();
    assert_eq!(a.sync().push.applied, 2);
    b.sync();
    let old = read(&b).unwrap();
    assert!(!old.pending);
    assert_eq!(old.time_off.reason.as_deref(), Some("Reviewed"));
    let current = read(&a).unwrap().time_off;
    ops::update_time_off(&mut a.store, &current, at, end, "Remote edit").unwrap();
    assert_eq!(a.sync().push.applied, 1);

    ops::delete_time_off(&mut b.store, &old.time_off).unwrap();
    assert!(read(&b).is_none());
    let report = b.sync();
    assert_eq!(report.push.rejected, 1, "{report:?}");
    let fresh = read(&b).unwrap();
    assert_eq!(fresh.time_off.reason.as_deref(), Some("Remote edit"));
    ops::delete_time_off(&mut b.store, &fresh.time_off).unwrap();
    assert_eq!(b.sync().push.applied, 1);
    a.sync();
    assert!(read(&a).is_none());
    assert!(day_items(&a, at, &c.staff).iter().any(|item| {
        item.appointment.id == appt && item.appointment.status == AppointmentStatus::Booked
    }));
}

#[test]
#[ignore = "needs the real API, Postgres and Valkey (see README)"]
fn an_appointment_created_offline_reaches_the_server_and_other_devices() {
    let mut a = Device::sign_in();
    let mut b = Device::sign_in();
    a.sync();
    b.sync();
    let c = catalog(&a);
    let at = free_slot(&a, &c.staff);

    // Offline on device A: no sync call happens between the user's actions and the assertions.
    let client = ops::create_client(&mut a.store, "Offline Lucia", Some("1155550101")).unwrap();
    let appt = ops::create_appointment(&mut a.store, booking(&c, &c.staff, &client, at)).unwrap();
    let items = day_items(&a, at, &c.staff);
    assert!(
        items.iter().any(|i| i.appointment.id == appt && i.pending),
        "shown as pending sync"
    );
    assert_eq!(a.store.outbox_len().unwrap(), 2);

    // Reconnect.
    let report = a.sync();
    assert_eq!(report.push.applied, 2, "{report:?}");
    assert_eq!(a.store.outbox_len().unwrap(), 0);
    let items = day_items(&a, at, &c.staff);
    let mine = items
        .iter()
        .find(|i| i.appointment.id == appt)
        .expect("appointment mirrored after the pull");
    assert!(!mine.pending);
    assert_eq!(mine.appointment.version, 1);
    assert_eq!(mine.client_name, "Offline Lucia");

    // The server really has it: REST, and a second device's pull.
    let from = (at - Span::hours(1)).to_rfc3339();
    let to = (at + Span::hours(3)).to_rfc3339();
    let rest = a.rest_get(&format!(
        "/appointments?from={}&to={}",
        urlenc(&from),
        urlenc(&to)
    ));
    assert!(
        rest["appointments"]
            .as_array()
            .unwrap()
            .iter()
            .any(|x| x["id"] == json!(appt)),
        "{rest}"
    );
    b.sync();
    assert!(
        day_items(&b, at, &c.staff)
            .iter()
            .any(|i| i.appointment.id == appt && !i.pending)
    );

    // Move then cancel offline on device A, in one batch with consecutive versions.
    ops::reschedule_appointment(&mut a.store, &appt, Some(at + Span::hours(2)), None).unwrap();
    ops::cancel_appointment(&mut a.store, &appt).unwrap();
    a.sync();
    assert_eq!(a.store.outbox_len().unwrap(), 0);
    assert!(a.store.conflicts().unwrap().is_empty());
    b.sync();
    assert_eq!(
        b.store.appointment(&appt).unwrap().unwrap().status,
        AppointmentStatus::Cancelled
    );
}

fn urlenc(s: &str) -> String {
    s.replace('+', "%2B").replace(':', "%3A")
}

#[test]
#[ignore = "needs the real API, Postgres and Valkey (see README)"]
fn a_slot_taken_while_offline_becomes_a_resolvable_conflict() {
    let mut a = Device::sign_in();
    let mut b = Device::sign_in();
    a.sync();
    b.sync();
    let c = catalog(&a);
    let at = free_slot(&a, &c.staff);
    let client_a = ops::create_client(&mut a.store, "Offline Ana", None).unwrap();
    let client_b = ops::create_client(&mut b.store, "Online Bea", None).unwrap();

    // Device A books offline; meanwhile device B books the same staff and time and syncs first.
    let mine = ops::create_appointment(&mut a.store, booking(&c, &c.staff, &client_a, at)).unwrap();
    let theirs =
        ops::create_appointment(&mut b.store, booking(&c, &c.staff, &client_b, at)).unwrap();
    b.sync();

    // A reconnects: its client is created, its booking is rejected.
    let report = a.sync();
    assert_eq!(report.push.applied, 1, "{report:?}");
    assert_eq!(report.push.rejected, 1, "{report:?}");
    let conflicts = a.store.conflicts().unwrap();
    assert_eq!(conflicts.len(), 1);
    assert_eq!(conflicts[0].reason, "slot_taken");
    assert_eq!(conflicts[0].entity_id, mine);
    assert_eq!(a.store.outbox_len().unwrap(), 0);
    let items = day_items(&a, at, &c.staff);
    assert!(
        items.iter().any(|i| i.appointment.id == theirs),
        "the winner is on the calendar"
    );
    assert!(
        !items.iter().any(|i| i.appointment.id == mine),
        "the loser is not"
    );

    // Resolve by rescheduling two hours later (a different time, same staff): it now applies.
    ops::resolve_conflict(
        &mut a.store,
        &conflicts[0].mutation_id,
        Resolution::Reschedule {
            starts_at: at + Span::hours(2),
            staff_id: None,
        },
    )
    .unwrap();
    let report = a.sync();
    assert_eq!(report.push.applied, 1, "{report:?}");
    assert!(a.store.conflicts().unwrap().is_empty());
    let moved = a
        .store
        .appointment(&mine)
        .unwrap()
        .expect("booked after resolution");
    assert_eq!(moved.starts_at, at + Span::hours(2));

    // Clean up so reruns find the slots free again.
    for id in [&mine, &theirs] {
        ops::cancel_appointment(&mut a.store, id).unwrap();
    }
    a.sync();
    assert!(a.store.conflicts().unwrap().is_empty());
}

#[test]
#[ignore = "needs the real API, Postgres and Valkey (see README)"]
fn resending_a_mutation_is_idempotent_and_deletes_arrive_as_tombstones() {
    let mut a = Device::sign_in();
    let mut b = Device::sign_in();
    a.sync();
    b.sync();
    let c = catalog(&a);

    // Idempotent replay of the exact same wire mutation.
    let id = uuid::Uuid::now_v7().to_string();
    let req = PushRequest {
        generation: None,
        device_id: a.store.device_id().unwrap(),
        mutations: vec![WireMutation {
            mutation_id: uuid::Uuid::now_v7().to_string(),
            created_at: Utc::now().to_rfc3339(),
            kind: "client.create".into(),
            payload: json!({"id": id, "name": "Replay Rosa"}),
        }],
    };
    let first = a.transport.push(&req).unwrap();
    let second = a.transport.push(&req).unwrap();
    assert!(
        matches!(
            first.results[0],
            MutationResult::Applied {
                replayed: false,
                ..
            }
        ),
        "{first:?}"
    );
    assert!(
        matches!(
            second.results[0],
            MutationResult::Applied { replayed: true, .. }
        ),
        "{second:?}"
    );

    // Time off created on A reaches B; its deletion reaches B as a tombstone.
    let off = uuid::Uuid::now_v7().to_string();
    let from = Utc::now() + Span::days(80);
    a.store
        .enqueue(
            "time_off.create",
            &off,
            json!({"id": off, "staffId": c.other_staff, "startsAt": from.to_rfc3339(), "endsAt": (from + Span::hours(3)).to_rfc3339(), "reason": "test"}),
        )
        .unwrap();
    a.sync();
    b.sync();
    let window = |d: &Device| {
        d.store
            .time_off_between(
                from.timestamp_millis() - 1,
                (from + Span::hours(4)).timestamp_millis(),
            )
            .unwrap()
    };
    assert!(window(&b).iter().any(|t| t.id == off));
    a.store
        .enqueue(
            "time_off.delete",
            &off,
            json!({"id": off, "staffId": c.other_staff}),
        )
        .unwrap();
    a.sync();
    b.sync();
    assert!(!window(&b).iter().any(|t| t.id == off), "tombstone applied");
    assert!(b.store.cursor().unwrap() >= a.store.cursor().unwrap().min(b.store.cursor().unwrap()));
}

#[test]
#[ignore = "needs the real API, Postgres and Valkey (see README)"]
fn the_stream_nudge_makes_the_runner_pull_without_polling() {
    let mut a = Device::sign_in();
    a.sync();
    let catalogue = catalog(&a);
    let b = Device::sign_in();
    let status: SharedStatus = Default::default();
    let core = RunnerCore::new(
        Store::open(&b.path).unwrap(),
        b.transport.clone(),
        status.clone(),
    );
    let runner = SyncRunner::spawn(core);
    let live = Arc::new(AtomicBool::new(false));
    let stop = Arc::new(AtomicBool::new(false));
    let listener = spawn_stream_listener(
        b.transport.clone(),
        runner.sender(),
        live.clone(),
        stop.clone(),
    );

    wait(
        Duration::from_secs(10),
        "the first sync and the SSE connection",
        || {
            status.lock().unwrap().connectivity == Connectivity::Online
                && live.load(Ordering::SeqCst)
        },
    );
    let reader = Store::open(&b.path).unwrap();
    assert!(reader.booking_notices_after(0).unwrap().is_empty());

    // A writes; B's runner is only woken by the stream (the poll interval is 60 s).
    let name = format!("Nudge {}", uuid::Uuid::now_v7());
    let client_id = ops::create_client(&mut a.store, &name, None).unwrap();
    let starts_at = free_slot(&a, &catalogue.staff);
    let appointment_id = ops::create_appointment(
        &mut a.store,
        booking(&catalogue, &catalogue.staff, &client_id, starts_at),
    )
    .unwrap();
    a.sync();
    assert!(a.store.booking_notices_after(0).unwrap().is_empty());
    wait(Duration::from_secs(10), "the nudged pull", || {
        reader.appointment(&appointment_id).unwrap().is_some()
    });
    assert!(reader.clients().unwrap().iter().any(|c| c.name == name));
    let notices = reader.booking_notices_after(0).unwrap();
    assert_eq!(notices.len(), 1);
    assert_eq!(notices[0].1.id, appointment_id);
    assert_eq!(notices[0].1.client_name.as_deref(), Some(name.as_str()));

    let initial = b
        .transport
        .appointment_annotations(&appointment_id)
        .unwrap();
    let appointment_version = initial.appointment_version.unwrap();
    let note = "Synthetic private note sent during the live stream";
    let original_edit = UpdateServiceAnnotations {
        appointment_version,
        service_position: 0,
        version: 0,
        requested: None,
        internal_note: note.into(),
    };
    let published = a
        .transport
        .update_service_annotations(&appointment_id, &original_edit)
        .unwrap()
        .unwrap();
    let published_version = published.appointment_version.unwrap();
    wait(
        Duration::from_secs(3),
        "the new note revision to reach native",
        || {
            reader
                .appointment(&appointment_id)
                .unwrap()
                .is_some_and(|appointment| appointment.version == published_version)
        },
    );
    let latest = b
        .transport
        .appointment_annotations(&appointment_id)
        .unwrap();
    assert_eq!(latest.rows[0].internal_note.as_deref(), Some(note));
    let path = format!("/appointments/{appointment_id}/context");
    assert_eq!(a.rest_get(&path)["rows"][0]["internalNote"], note);
    let prefix = std::env::var("SOB_TEST_REST_PREFIX").unwrap_or_default();
    let web_note = "Synthetic private note edited through the web API";
    let mut response = ureq::patch(&format!("{}{prefix}{path}", a.base))
        .header("Cookie", &a.cookie)
        .content_type("application/json")
        .send(
            json!({
                "appointmentVersion": published_version,
                "servicePosition": 0,
                "version": latest.rows[0].version,
                "internalNote": web_note,
            })
            .to_string(),
        )
        .unwrap();
    let web_edit: AppointmentAnnotations =
        serde_json::from_str(&response.body_mut().read_to_string().unwrap()).unwrap();
    let web_version = web_edit.appointment_version.unwrap();
    wait(
        Duration::from_secs(3),
        "web note revision to reach native",
        || {
            reader
                .appointment(&appointment_id)
                .unwrap()
                .is_some_and(|appointment| {
                    appointment.version == web_version
                        && appointment.service_badges[0].internal_note
                })
        },
    );
    let latest = b
        .transport
        .appointment_annotations(&appointment_id)
        .unwrap();
    assert_eq!(latest.rows[0].internal_note.as_deref(), Some(web_note));
    let replica = reader.appointment(&appointment_id).unwrap().unwrap();
    assert!(!serde_json::to_string(&replica).unwrap().contains(web_note));
    assert_eq!(reader.booking_notices_after(0).unwrap().len(), 1);
    assert!(
        b.transport
            .update_service_annotations(&appointment_id, &original_edit)
            .unwrap()
            .is_none()
    );
    assert_eq!(a.rest_get(&path)["rows"][0]["internalNote"], web_note);

    stop.store(true, Ordering::SeqCst);
    runner.stop();
    drop(listener); // the thread exits at the next ping or reconnect; not joined on purpose
}

#[test]
#[ignore = "needs the real API, Postgres and Valkey (see README)"]
fn cash_updates_are_visible_to_the_connected_native_replica_and_web_api() {
    let mut browser = Device::sign_in();
    browser.sync();
    let native = Device::sign_in();
    let status: SharedStatus = Default::default();
    let runner = SyncRunner::spawn(RunnerCore::new(
        Store::open(&native.path).unwrap(),
        native.transport.clone(),
        status.clone(),
    ));
    let live = Arc::new(AtomicBool::new(false));
    let stop = Arc::new(AtomicBool::new(false));
    let listener = spawn_stream_listener(
        native.transport.clone(),
        runner.sender(),
        live.clone(),
        stop.clone(),
    );
    wait(Duration::from_secs(5), "native startup", || {
        status.lock().unwrap().connectivity == Connectivity::Online && live.load(Ordering::SeqCst)
    });
    let replica = Store::open(&native.path).unwrap();
    let before = replica.live_view_revision("commerce").unwrap();
    let start = Instant::now();
    let opened = browser.rest_post(
        "/admin/commerce/cash-sessions",
        json!({"openingCents": 2300}),
    );
    wait(
        Duration::from_secs(3),
        "web cash opening to reach native",
        || replica.live_view_revision("commerce").unwrap() > before,
    );
    let native_session = native.transport.current_cash_session().unwrap().unwrap();
    assert_eq!(
        native_session.id.to_string(),
        opened["id"].as_str().unwrap()
    );
    eprintln!(
        "Web to native cash state: {} ms",
        start.elapsed().as_millis()
    );

    let start = Instant::now();
    let movement = CashCommand::adjust(
        &native_session,
        CashAdjustment::Deposit,
        125,
        "Realtime synthetic deposit".into(),
    );
    eprintln!(
        "Native cash request at {} ms since epoch",
        Utc::now().timestamp_millis()
    );
    let adjusted = native.transport.update_cash_session(&movement).unwrap();
    assert_eq!(adjusted.expected_cents, 2425);
    let web = browser.rest_get("/admin/commerce/cash-sessions/current");
    assert_eq!(web["session"]["expectedCents"], 2425);
    eprintln!(
        "Native to web API cash state: {} ms",
        start.elapsed().as_millis()
    );
    native
        .transport
        .update_cash_session(&CashCommand::close(&adjusted, 2425))
        .unwrap();

    stop.store(true, Ordering::SeqCst);
    runner.stop();
    drop(listener);
}

fn wait(max: Duration, what: &str, mut f: impl FnMut() -> bool) {
    let start = Instant::now();
    while start.elapsed() < max {
        if f() {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("timed out waiting for {what}");
}

#[test]
#[ignore = "needs the real API, Postgres and Valkey (see README)"]
fn native_calendar_inbox_reads_lifecycle_and_archives_a_notice() {
    let mut device = Device::sign_in();
    device.sync();
    let catalogue = catalog(&device);
    let starts_at = free_slot(&device, &catalogue.staff);
    let client = ops::create_client(&mut device.store, "Native inbox test", None).unwrap();
    let id = ops::create_appointment(
        &mut device.store,
        booking(&catalogue, &catalogue.staff, &client, starts_at),
    )
    .unwrap();
    device.sync();
    ops::reschedule_appointment(
        &mut device.store,
        &id,
        Some(starts_at + Span::hours(1)),
        None,
    )
    .unwrap();
    device.sync();
    ops::cancel_appointment(&mut device.store, &id).unwrap();
    device.sync();

    let inbox = device.transport.calendar_inbox(false, 1).unwrap();
    let notices = inbox
        .entries
        .iter()
        .filter(|notice| notice.appointment_id == id)
        .collect::<Vec<_>>();
    assert_eq!(notices.len(), 3);
    assert_eq!(notices[0].kind, CalendarNoticeKind::Cancelled);
    assert_eq!(notices[1].kind, CalendarNoticeKind::Rescheduled);
    assert_eq!(notices[2].kind, CalendarNoticeKind::New);
    assert_eq!(notices[2].starts_at, starts_at);
    assert_eq!(notices[2].appointment_starts_at, starts_at + Span::hours(1));

    let notice_id = &notices[0].id;
    device
        .transport
        .set_calendar_notice_archived(notice_id, true)
        .unwrap();
    assert!(
        !device
            .transport
            .calendar_inbox(false, 1)
            .unwrap()
            .entries
            .iter()
            .any(|n| n.id == *notice_id)
    );
    assert!(
        device
            .transport
            .calendar_inbox(true, 1)
            .unwrap()
            .entries
            .iter()
            .any(|n| n.id == *notice_id)
    );
    device
        .transport
        .set_calendar_notice_archived(notice_id, false)
        .unwrap();
    assert!(
        device
            .transport
            .calendar_inbox(false, 1)
            .unwrap()
            .entries
            .iter()
            .any(|n| n.id == *notice_id)
    );
}

#[test]
#[ignore = "needs the real API, Postgres and Valkey (see README)"]
fn native_waitlist_uses_the_same_request_and_cancellation_rules_as_web() {
    let mut desk = Device::sign_in();
    desk.sync();
    let catalog = catalog(&desk);
    let date = free_slot(&desk, &catalog.staff)
        .with_timezone(&salon_tz(&desk.store).unwrap())
        .date_naive();
    let policy = desk.transport.waitlist(1, true).unwrap().policy;
    if !policy.enabled {
        let updated = desk
            .transport
            .update_waitlist_policy(&WaitlistPolicy {
                enabled: true,
                ..policy.clone()
            })
            .unwrap();
        assert!(updated.enabled);
        assert_eq!(updated.version, policy.version + 1);
        assert!(desk.transport.update_waitlist_policy(&policy).is_err());
    }
    let client = ops::create_client(&mut desk.store, "Native waitlist test", None).unwrap();
    desk.sync();
    let draft = WaitlistRequest {
        client_id: client,
        staff_id: Some(catalog.staff),
        service_ids: vec![catalog.haircut],
        from_date: date,
        to_date: date,
        from_time: "00:01".into(),
        to_time: "00:02".into(),
        imported_entry_id: None,
        idempotency_key: WaitlistRequest::new_key(),
    };
    let created = desk.transport.join_waitlist(&draft).unwrap();
    assert_eq!(created.state, WaitlistState::Waiting);
    assert_eq!(desk.transport.join_waitlist(&draft).unwrap().id, created.id);
    assert!(
        desk.transport
            .waitlist(1, true)
            .unwrap()
            .entries
            .iter()
            .any(|row| row.id == created.id)
    );
    assert_eq!(
        desk.transport
            .cancel_waitlist(&created.id, created.version)
            .unwrap()
            .state,
        WaitlistState::Cancelled
    );
    assert!(
        !desk
            .transport
            .waitlist(1, true)
            .unwrap()
            .entries
            .iter()
            .any(|row| row.id == created.id)
    );
    assert!(
        desk.transport
            .waitlist(1, false)
            .unwrap()
            .entries
            .iter()
            .any(|row| row.id == created.id && row.state == WaitlistState::Cancelled)
    );
}

#[test]
#[ignore = "needs the synthetic imported request from the production smoke test"]
fn native_imported_waitlist_follows_the_web_policy_through_the_proxy() {
    let import_id = env("SOB_TEST_IMPORTED_WAITLIST");
    let device = proxy_device();
    let mut browser = Device::sign_in();
    browser.sync();
    let haircut = catalog(&browser).haircut;
    let list = device.transport.waitlist(1, true).unwrap();
    let source = list
        .imported
        .iter()
        .find(|row| row.id == import_id)
        .expect("the fixture request is available to the linked client");
    let web_list = || -> WaitlistPage {
        serde_json::from_value(browser.rest_get("/admin/waitlist?active=true")).unwrap()
    };
    assert!(web_list().imported.contains(source));
    let set_offers = |policy: &WaitlistPolicy, enabled| {
        let update = WaitlistPolicy {
            enabled,
            ..policy.clone()
        };
        let mut reply = ureq::put(&format!("{}/api/admin/waitlist/policy", browser.base))
            .header("Cookie", &browser.cookie)
            .header("Origin", &browser.base)
            .content_type("application/json")
            .send(serde_json::to_string(&update).unwrap())
            .unwrap();
        serde_json::from_str::<WaitlistPolicy>(&reply.body_mut().read_to_string().unwrap()).unwrap()
    };
    let enabled = set_offers(&list.policy, true);
    let draft = WaitlistRequest {
        client_id: source.client_id.clone(),
        staff_id: None,
        service_ids: vec![haircut],
        from_date: source.requested_date,
        to_date: source.requested_date,
        // The fixture must never match an offer even after the policy is enabled.
        from_time: "00:01".into(),
        to_time: "00:02".into(),
        imported_entry_id: Some(import_id.clone()),
        idempotency_key: WaitlistRequest::new_key(),
    };
    assert!(matches!(
        device.transport.join_waitlist(&draft),
        Err(TransportError::BadRequest(message)) if message.contains("Pause automatic offers")
    ));
    let refresh = device.transport.waitlist(1, true).unwrap();
    assert_eq!(refresh.policy.version, enabled.version);
    assert!(refresh.imported.iter().any(|row| row == source));

    let paused = set_offers(&enabled, false);
    assert!(!device.transport.waitlist(1, true).unwrap().policy.enabled);
    device.assert_import_requires_staff_preference(&draft);
    let saved = device.transport.join_waitlist(&draft).unwrap();
    assert_eq!(saved.state, WaitlistState::Waiting);
    assert_eq!(saved.staff_id, None);
    assert_eq!(saved.client_id, source.client_id);
    assert_eq!(saved.from_date, source.requested_date);
    assert_eq!(saved.to_date, source.requested_date);
    assert_eq!(saved.service_ids, draft.service_ids);
    assert!(saved.offer.is_none());

    let assert_linked_entry = || {
        for refreshed in [device.transport.waitlist(1, true).unwrap(), web_list()] {
            assert!(!refreshed.imported.iter().any(|row| row.id == import_id));
            let client_entries = refreshed
                .entries
                .iter()
                .filter(|row| row.client_id == source.client_id)
                .collect::<Vec<_>>();
            assert_eq!(client_entries, vec![&saved]);
        }
    };
    assert_linked_entry();
    let reenabled = set_offers(&paused, true);
    assert!(reenabled.enabled);
    let replay = device.transport.join_waitlist(&draft).unwrap();
    assert_eq!(replay.id, saved.id);
    assert!(replay.offer.is_none());
    assert_linked_entry();
    assert_eq!(
        device
            .transport
            .cancel_waitlist(&saved.id, replay.version)
            .unwrap()
            .state,
        WaitlistState::Cancelled
    );
    if !list.policy.enabled {
        assert!(!set_offers(&reenabled, false).enabled);
    }
    device.disconnect_and_check("/api/admin/waitlist/desk");
}

#[test]
#[ignore = "needs the real waitlist worker (see README)"]
fn native_waitlist_reviews_accepts_and_requeues_real_offers() {
    let mut desk = Device::sign_in();
    desk.sync();
    let catalog = catalog(&desk);
    let starts_at = free_slot(&desk, &catalog.staff);
    let service = desk.rest_post(
        "/admin/services",
        json!({
            "name": "Synthetic waitlist service with intake", "durationMinutes": 30,
            "priceCents": 1500, "currency": "EUR", "staffIds": [catalog.staff],
        }),
    );
    let service_id = service["id"].as_str().unwrap();
    let tz = salon_tz(&desk.store).unwrap();
    let policy = desk.transport.waitlist(1, true).unwrap().policy;
    if !policy.enabled {
        desk.transport
            .update_waitlist_policy(&WaitlistPolicy {
                enabled: true,
                ..policy
            })
            .unwrap();
    }
    let clients = ["Offer accept test", "Offer requeue test"]
        .map(|name| ops::create_client(&mut desk.store, name, None).unwrap());
    desk.sync();
    let entries = clients
        .into_iter()
        .enumerate()
        .map(|(i, client_id)| {
            let start = (starts_at + Span::hours(i as i64)).with_timezone(&tz);
            desk.transport
                .join_waitlist(&WaitlistRequest {
                    client_id,
                    staff_id: Some(catalog.staff.clone()),
                    service_ids: vec![service_id.to_owned()],
                    from_date: start.date_naive(),
                    to_date: start.date_naive(),
                    from_time: start.format("%H:%M").to_string(),
                    to_time: (start + Span::hours(1)).format("%H:%M").to_string(),
                    imported_entry_id: None,
                    idempotency_key: WaitlistRequest::new_key(),
                })
                .unwrap()
        })
        .collect::<Vec<_>>();
    let mut offers = vec![];
    let mut next_probe = Instant::now();
    wait(
        Duration::from_secs(70),
        "the waitlist worker offering both slots",
        || {
            if Instant::now() < next_probe {
                return false;
            }
            next_probe = Instant::now() + Duration::from_secs(1);
            offers = desk
                .transport
                .waitlist(1, true)
                .unwrap()
                .entries
                .into_iter()
                .filter(|row| entries.iter().any(|entry| row.id == entry.id) && row.offer.is_some())
                .collect();
            offers.len() == 2
        },
    );
    let accepted = offers
        .iter()
        .find(|offer| offer.id == entries[0].id)
        .unwrap();
    let requeued = offers
        .iter()
        .find(|offer| offer.id == entries[1].id)
        .unwrap();
    let linked =
        (std::env::var("SOB_TEST_REST_PREFIX").as_deref() == Ok("/api")).then(proxy_device);
    let transport = linked
        .as_ref()
        .map_or(&desk.transport, |device| &device.transport);
    let (initial, can_waive) = transport.waitlist_offer_requirements(accepted).unwrap();
    assert!(initial.forms.is_empty() && can_waive);
    let yes_no = uuid::Uuid::now_v7().to_string();
    let note = uuid::Uuid::now_v7().to_string();
    let draft = desk.rest_post("/admin/intake-forms", json!({
        "idempotencyKey": uuid::Uuid::now_v7(), "definition": {
            "title": "Synthetic offer review", "requiredAtBooking": true, "allowTeamResponses": true,
            "allServices": false, "serviceIds": [service_id], "fields": [
                {"id": yes_no, "label": "Is this answer yes?", "kind": "boolean", "required": true},
                {"id": note, "label": "Multiline notes", "kind": "textarea", "required": true},
            ],
        }
    }));
    let form_id = draft["id"].as_str().unwrap();
    desk.rest_post(
        &format!("/admin/intake-forms/{form_id}/publish"),
        json!({"version": draft["version"]}),
    );
    let (requirements, _) = transport.waitlist_offer_requirements(accepted).unwrap();
    let form = &requirements.forms[0];
    let offer = accepted.offer.as_ref().unwrap();
    let input = AcceptOffer {
        version: accepted.version,
        offer_id: offer.id.clone(),
        expected_total_cents: offer.price_cents,
        idempotency_key: WaitlistRequest::new_key(),
        intake_review_hash: requirements.review_hash,
        intake_submission_ids: Vec::new(),
        intake_responses: vec![
            form.definition
                .team_response(
                    &form.id,
                    true,
                    [
                        (yes_no.clone(), Answer::Boolean(false)),
                        (note.clone(), Answer::Text("First line\nSecond line".into())),
                    ]
                    .into(),
                )
                .unwrap(),
        ],
        protection_waiver_reason: None,
    };
    assert!(matches!(
        transport.accept_waitlist_offer(
            &accepted.id,
            &AcceptOffer {
                intake_review_hash: initial.review_hash,
                intake_responses: Vec::new(),
                ..input.clone()
            }
        ),
        Err(sob_core::waitlist::AcceptOfferError::IntakeChanged)
    ));
    assert!(
        transport
            .accept_waitlist_offer(
                &accepted.id,
                &AcceptOffer {
                    expected_total_cents: input.expected_total_cents + 1,
                    ..input.clone()
                }
            )
            .is_err()
    );
    let booked = transport
        .accept_waitlist_offer(&accepted.id, &input)
        .unwrap()
        .appointment;
    assert_eq!(booked.starts_at, offer.starts_at);
    let refreshed = AcceptOffer {
        intake_review_hash: "a".repeat(64),
        intake_responses: vec![
            form.definition
                .team_response(
                    &form.id,
                    true,
                    [
                        (yes_no.clone(), Answer::Boolean(false)),
                        (
                            note.clone(),
                            Answer::Text("  First line\nSecond line  ".into()),
                        ),
                    ]
                    .into(),
                )
                .unwrap(),
        ],
        ..input.clone()
    };
    assert_eq!(
        transport
            .accept_waitlist_offer(&accepted.id, &refreshed)
            .unwrap()
            .appointment
            .id,
        booked.id
    );
    assert!(
        transport
            .accept_waitlist_offer(
                &accepted.id,
                &AcceptOffer {
                    intake_responses: vec![
                        form.definition
                            .team_response(
                                &form.id,
                                true,
                                [
                                    (yes_no.clone(), Answer::Boolean(true)),
                                    (note.clone(), Answer::Text("First line\nSecond line".into())),
                                ]
                                .into()
                            )
                            .unwrap()
                    ],
                    ..input.clone()
                }
            )
            .is_err()
    );
    let responses = desk.rest_get(&format!("/admin/clients/{}/intake", accepted.client_id));
    let rows = responses["submissions"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["appointmentId"], booked.id);
    assert_eq!(rows[0]["source"], "team");
    let detail = desk.rest_get(&format!(
        "/intake/submissions/{}",
        rows[0]["id"].as_str().unwrap()
    ));
    assert_eq!(detail["answers"][&yes_no], false);
    assert_eq!(detail["answers"][&note], "First line\nSecond line");
    let requeue = desk
        .transport
        .requeue_waitlist_offer(
            &requeued.id,
            requeued.version,
            &requeued.offer.as_ref().unwrap().id,
        )
        .unwrap();
    assert_eq!(requeue.state, WaitlistState::Waiting);
    assert!(requeue.offer.is_none());
    desk.sync();
    assert!(desk.store.appointment(&booked.id).unwrap().is_some());
}

#[test]
#[ignore = "requires a running, seeded stack"]
fn native_directory_replays_contacts_and_preserves_newer_edits() {
    let mut first = Device::sign_in();
    let mut second = Device::sign_in();
    first.sync();
    assert!(first.store.client_directory_enabled().unwrap());
    let email = format!("native-{}@example.test", uuid::Uuid::now_v7());
    let id = ops::create_directory_client(
        &mut first.store,
        "Native Directory",
        "+34 600 100 200",
        &email,
        "First notes",
    )
    .unwrap();
    let read = |device: &Device| {
        calendar::directory_clients(&device.store)
            .unwrap()
            .into_iter()
            .find(|client| client.id == id)
            .unwrap()
    };
    assert_eq!(read(&first).email.as_deref(), Some(email.as_str()));
    first.sync();
    second.sync();
    let original = read(&second);
    let first_snapshot = read(&first);
    ops::update_directory_client(
        &mut first.store,
        &first_snapshot,
        "Reviewed name",
        "",
        "Saved by first device",
    )
    .unwrap();
    assert_eq!(read(&first).name, "Reviewed name");
    assert!(read(&first).phone.is_none());
    first.sync();
    ops::update_directory_client(
        &mut second.store,
        &original,
        "Stale name",
        "12345",
        "Saved by second device",
    )
    .unwrap();
    second.sync();
    assert_eq!(read(&second).name, "Reviewed name");
    assert!(read(&second).phone.is_none());
    assert!(second.store.conflicts().unwrap().iter().any(|conflict| {
        conflict.entity_id == id
            && conflict.kind == "client.update"
            && conflict.reason == "conflict"
    }));
}

#[test]
#[ignore = "needs the real API behind the web gateway (see README)"]
fn native_books_with_current_intake_and_an_inline_client_through_the_proxy() {
    use sob_core::booking::{BookingError, BookingTerms};
    use sob_core::intake::IntakeSelection;

    let mut browser = Device::sign_in();
    browser.sync();
    let catalog = catalog(&browser);
    let start = free_slot(&browser, &catalog.staff);
    let service = browser.rest_post(
        "/admin/services",
        json!({
            "name": "Synthetic agenda service", "durationMinutes": 30, "priceCents": 1500,
            "currency": "EUR", "staffIds": [catalog.staff],
        }),
    );
    let service_id = service["id"].as_str().unwrap();
    let household_contact = ops::create_client(
        &mut browser.store,
        "A different synthetic client on the same phone",
        Some("+34 600 000 222"),
    )
    .unwrap();
    browser.sync();
    let device = proxy_device();
    let terms = BookingTerms::prepare(
        &browser.store,
        NewAppointment {
            staff_id: catalog.staff,
            client_id: String::new(),
            service_ids: vec![service_id.into()],
            starts_at: start,
            notes: Some("Synthetic appointment note".into()),
            override_notice: false,
        },
        Some((
            "Synthetic client with reviewed intake",
            Some("+34 600 000 222"),
        )),
    )
    .unwrap();
    let initial = device
        .transport
        .direct_booking_requirements(&terms)
        .unwrap();
    assert_eq!(
        initial.desktop_generation.as_deref(),
        Some(terms.generation())
    );
    let answer_id = uuid::Uuid::now_v7().to_string();
    let draft = browser.rest_post("/admin/intake-forms", json!({
        "idempotencyKey": uuid::Uuid::now_v7(), "definition": {
            "title": "Synthetic agenda intake", "requiredAtBooking": true, "allowTeamResponses": true,
            "allServices": false, "serviceIds": [service_id], "fields": [
                {"id": answer_id, "label": "Is this statement true?", "kind": "boolean", "required": true},
            ],
        }
    }));
    let form_id = draft["id"].as_str().unwrap();
    browser.rest_post(
        &format!("/admin/intake-forms/{form_id}/publish"),
        json!({"version": draft["version"]}),
    );
    let stale = terms.reviewed(initial.review_hash, IntakeSelection::default());
    assert!(matches!(
        device.transport.create_reviewed_booking(&stale),
        Err(BookingError::IntakeChanged)
    ));
    assert!(browser.store.outbox(50).unwrap().is_empty());
    let current = device
        .transport
        .direct_booking_requirements(&terms)
        .unwrap();
    let form = &current.forms[0];
    let answer = form
        .definition
        .team_response(
            &form.id,
            true,
            [(answer_id.clone(), Answer::Boolean(false))].into(),
        )
        .unwrap();
    let request = terms.reviewed(
        current.review_hash,
        IntakeSelection {
            saved: vec![],
            inline: vec![answer],
        },
    );
    let origin_notice = browser.store.booking_notice_head().unwrap();
    request.mark_local_dispatch(&mut browser.store).unwrap();
    request.mark_local_dispatch(&mut browser.store).unwrap();
    let appointment = device.transport.create_reviewed_booking(&request).unwrap();
    assert_eq!(
        device
            .transport
            .create_reviewed_booking(&request)
            .unwrap()
            .id,
        appointment.id
    );
    browser.sync();
    assert!(
        browser
            .store
            .booking_notices_after(origin_notice)
            .unwrap()
            .iter()
            .all(|(_, notice)| notice.id != appointment.id)
    );
    let local = browser.store.appointment(&appointment.id).unwrap().unwrap();
    assert_ne!(local.client_id, household_contact);
    let unrelated = browser.rest_get(&format!("/admin/clients/{household_contact}/intake"));
    assert_eq!(unrelated["submissions"].as_array().unwrap().len(), 0);
    let rows = browser.rest_get(&format!("/admin/clients/{}/intake", local.client_id));
    let responses = rows["submissions"].as_array().unwrap();
    assert_eq!(responses.len(), 1);
    assert_eq!(responses[0]["appointmentId"], appointment.id);
    assert_eq!(responses[0]["source"], "team");
    let detail = browser.rest_get(&format!(
        "/intake/submissions/{}",
        responses[0]["id"].as_str().unwrap()
    ));
    assert_eq!(detail["answers"][&answer_id], false);
    assert!(browser.store.outbox(50).unwrap().is_empty());
    assert!(
        serde_json::to_value(local)
            .unwrap()
            .get("intakeResponses")
            .is_none()
    );
}
