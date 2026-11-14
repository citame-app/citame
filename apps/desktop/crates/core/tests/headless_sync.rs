//! Headless sync tests against the REAL API, Postgres and Valkey (no server mocks).
//!
//! They are `#[ignore]`d so a plain `cargo test` needs no infrastructure. Run them with a
//! dedicated database (see apps/desktop/README.md):
//!
//! ```text
//! SOB_TEST_API_URL=http://127.0.0.1:3055 \
//! SOB_TEST_EMAIL=owner@desktop.test SOB_TEST_PASSWORD=... \
//!   cargo test -p sob-core --test headless_sync -- --ignored --test-threads=1
//! ```

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use chrono::{DateTime, Datelike, Duration as Span, NaiveTime, TimeZone, Utc};
use serde_json::json;
use sob_core::auth::{AuthProvider, BetterAuthSession, Credentials, SessionHandle};
use sob_core::calendar::{self, salon_tz};
use sob_core::http::{HttpTransport, spawn_stream_listener};
use sob_core::model::*;
use sob_core::ops::{self, NewAppointment, Resolution};
use sob_core::runner::{Connectivity, RunnerCore, SharedStatus, SyncRunner};
use sob_core::store::Store;
use sob_core::sync::{self, Transport};

fn env(name: &str) -> String {
    std::env::var(name)
        .unwrap_or_else(|_| panic!("{name} must be set to run the headless sync tests"))
}

struct Device {
    store: Store,
    transport: Arc<HttpTransport>,
    base: String,
    cookie: String,
    _dir: tempfile::TempDir,
    path: std::path::PathBuf,
}

impl Device {
    fn sign_in() -> Self {
        let base = env("SOB_TEST_API_URL");
        let auth = Arc::new(BetterAuthSession::new(&base));
        let session = auth
            .sign_in(&Credentials {
                email: env("SOB_TEST_EMAIL"),
                password: env("SOB_TEST_PASSWORD"),
            })
            .expect("sign in against the real API");
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
        let mut resp = ureq::get(&format!("{}{path}", self.base))
            .header("Cookie", &self.cookie)
            .call()
            .unwrap();
        serde_json::from_str(&resp.body_mut().read_to_string().unwrap()).unwrap()
    }
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
    let tz = salon_tz(&d.store).unwrap();
    let hours = d.store.working_hours().unwrap();
    for _ in 0..200 {
        let day = (Utc::now() + Span::days(4 + jitter(40) as i64))
            .with_timezone(&tz)
            .date_naive();
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
        if !busy {
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
    let before = status.lock().unwrap().cursor;

    // A writes; B's runner is only woken by the stream (the poll interval is 60 s).
    let name = format!("Nudge {}", uuid::Uuid::now_v7());
    ops::create_client(&mut a.store, &name, None).unwrap();
    a.sync();
    wait(Duration::from_secs(10), "the nudged pull", || {
        status.lock().unwrap().cursor > before
    });
    let reader = Store::open(&b.path).unwrap();
    assert!(reader.clients().unwrap().iter().any(|c| c.name == name));

    stop.store(true, Ordering::SeqCst);
    runner.stop();
    drop(listener); // the thread exits at the next ping or reconnect; not joined on purpose
}

fn wait(max: Duration, what: &str, f: impl Fn() -> bool) {
    let start = Instant::now();
    while start.elapsed() < max {
        if f() {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("timed out waiting for {what}");
}
