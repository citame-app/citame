use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

use serde_json::json;

use super::*;
use crate::model::*;
use crate::sync::TransportError;

struct Scripted {
    fail_with: Mutex<Option<TransportError>>,
    push_attempts: Mutex<Vec<Instant>>,
    pulls: AtomicUsize,
    cursor_after: i64,
}

impl Scripted {
    fn healthy() -> Arc<Self> {
        Arc::new(Self {
            fail_with: Mutex::new(None),
            push_attempts: Mutex::new(Vec::new()),
            pulls: 0.into(),
            cursor_after: 5,
        })
    }
    fn failing(e: TransportError) -> Arc<Self> {
        let s = Self::healthy();
        *s.fail_with.lock().unwrap() = Some(e);
        s
    }
    fn heal(&self) {
        *self.fail_with.lock().unwrap() = None;
    }
}

impl Transport for Scripted {
    fn push(&self, req: &PushRequest) -> Result<PushResponse, TransportError> {
        self.push_attempts.lock().unwrap().push(Instant::now());
        if let Some(e) = self.fail_with.lock().unwrap().clone() {
            return Err(e);
        }
        Ok(PushResponse {
            results: req
                .mutations
                .iter()
                .map(|m| MutationResult::Applied {
                    mutation_id: m.mutation_id.clone(),
                    applied_seq: Some(1),
                    replayed: false,
                })
                .collect(),
            head_seq: 1,
        })
    }
    fn pull(&self, since: i64, _limit: u32) -> Result<PullResponse, TransportError> {
        self.pulls.fetch_add(1, Ordering::SeqCst);
        if let Some(e) = self.fail_with.lock().unwrap().clone() {
            return Err(e);
        }
        Ok(PullResponse {
            generation: None,
            changes: vec![],
            next_cursor: since.max(self.cursor_after),
            has_more: false,
            refresh: vec![],
            time_off_scope: None,
            client_directory: None,
            gift_cards_scope: None,
            client_groups: None,
            booked_resource_ids: None,
            calendar_scope: None,
            viewer_role: None,
            viewer_edit_catalogue: None,
            peak_prices: None,
            peak_price_access: None,
            resource_pools: None,
            combinations: None,
            booking_combinations: None,
            booking_combination_access: None,
            booked_combination_terms: None,
            viewer_write_inventory: None,
            portfolio_uploads: None,
            viewer_read_inventory: None,
            head_seq: 5,
        })
    }
}

fn core_with(t: Arc<Scripted>, queued: usize) -> (RunnerCore, SharedStatus) {
    let mut store = Store::open_in_memory().unwrap();
    for i in 0..queued {
        store
            .enqueue(
                "client.create",
                &format!("c{i}"),
                json!({"id": format!("c{i}"), "name": "N"}),
            )
            .unwrap();
    }
    let status: SharedStatus = Default::default();
    (
        RunnerCore::new(store, t, status.clone()).with_jitter(|| 0.5),
        status,
    )
}

fn snap(s: &SharedStatus) -> SyncStatus {
    s.lock().unwrap().clone()
}

#[test]
fn a_successful_cycle_goes_online_clears_pending_and_waits_for_the_poll_interval() {
    let (mut core, status) = core_with(Scripted::healthy(), 2);
    let wait = core.run_cycle();
    let s = snap(&status);
    assert_eq!(wait, POLL_INTERVAL);
    assert_eq!(s.connectivity, Connectivity::Online);
    assert_eq!((s.pending, s.conflicts, s.cursor), (0, 0, 5));
    assert!(s.last_sync_at.is_some() && s.last_error.is_none() && !s.syncing);
    assert_eq!(s.retry_in, None);
}

#[test]
fn consecutive_failures_back_off_exponentially_and_keep_the_pending_count() {
    let (mut core, status) = core_with(
        Scripted::failing(TransportError::Offline("no route".into())),
        3,
    );
    let waits: Vec<_> = (0..4).map(|_| core.run_cycle()).collect();
    // jitter 0.5 of ceilings 1, 2, 4, 8 seconds
    assert_eq!(
        waits,
        vec![
            Duration::from_millis(500),
            Duration::from_secs(1),
            Duration::from_secs(2),
            Duration::from_secs(4)
        ]
    );
    let s = snap(&status);
    assert_eq!(s.connectivity, Connectivity::Offline);
    assert_eq!(s.pending, 3);
    assert_eq!(s.last_error.as_deref(), Some("offline: no route"));
    assert_eq!(s.retry_in, Some(Duration::from_secs(4)));
}

#[test]
fn recovery_resets_the_backoff() {
    let t = Scripted::failing(TransportError::Server("502".into()));
    let (mut core, status) = core_with(t.clone(), 1);
    core.run_cycle();
    core.run_cycle();
    t.heal();
    assert_eq!(core.run_cycle(), POLL_INTERVAL);
    assert_eq!(snap(&status).connectivity, Connectivity::Online);
    *t.fail_with.lock().unwrap() = Some(TransportError::Offline("x".into()));
    assert_eq!(
        core.run_cycle(),
        Duration::from_millis(500),
        "starts again from the first step"
    );
}

#[test]
fn retry_after_is_honored_as_a_floor() {
    let (mut core, _s) = core_with(
        Scripted::failing(TransportError::RateLimited(Some(Duration::from_secs(30)))),
        1,
    );
    assert_eq!(core.run_cycle(), Duration::from_secs(30));
}

#[test]
fn worker_wakes_cannot_bypass_a_rate_limit_and_pending_edits_sync_afterward() {
    let retry_after = Duration::from_secs(1);
    let t = Scripted::failing(TransportError::RateLimited(Some(retry_after)));
    let (core, status) = core_with(t.clone(), 1);
    let runner = SyncRunner::spawn(core);
    wait_for(&status, "rate limit", |s| {
        !s.syncing && s.retry_in.is_some()
    });
    assert_eq!(snap(&status).pending, 1);
    t.heal();

    runner.wake(Wake::Manual);
    runner.wake(Wake::Local);
    runner.wake(Wake::Nudge(6));
    wait_for(&status, "sync after cooldown", |s| {
        s.connectivity == Connectivity::Online && s.pending == 0 && !s.syncing
    });
    let attempts = t.push_attempts.lock().unwrap();
    assert_eq!(attempts.len(), 2);
    assert!(attempts[1].duration_since(attempts[0]) >= retry_after);
    runner.stop();
}

#[test]
fn an_expired_session_needs_the_user_and_does_not_burn_retries() {
    let (mut core, status) = core_with(Scripted::failing(TransportError::Unauthorized), 2);
    assert_eq!(core.run_cycle(), AUTH_WAIT);
    let s = snap(&status);
    assert_eq!(s.connectivity, Connectivity::AuthRequired);
    assert_eq!(s.pending, 2);
}

#[test]
fn nudges_only_matter_when_the_server_is_ahead_or_we_have_pending_work() {
    let (mut core, _s) = core_with(Scripted::healthy(), 0);
    core.run_cycle(); // cursor 5
    assert!(!core.nudge_is_news(5));
    assert!(!core.nudge_is_news(3));
    assert!(core.nudge_is_news(6));
}

fn wait_for(status: &SharedStatus, what: &str, f: impl Fn(&SyncStatus) -> bool) {
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(5) {
        if f(&status.lock().unwrap()) {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("timed out waiting for {what}: {:?}", snap(status));
}

#[test]
fn the_worker_syncs_on_start_on_wake_and_stops_cleanly() {
    let t = Scripted::failing(TransportError::Offline("down".into()));
    let (core, status) = core_with(t.clone(), 1);
    let runner = SyncRunner::spawn(core);
    wait_for(&status, "first (failed) cycle", |s| {
        s.connectivity == Connectivity::Offline
    });
    t.heal();
    runner.wake(Wake::Manual);
    wait_for(&status, "recovery", |s| {
        s.connectivity == Connectivity::Online && s.pending == 0
    });
    let pulls_before = t.pulls.load(Ordering::SeqCst);
    runner.wake(Wake::Nudge(5)); // not news: no extra work
    runner.wake(Wake::Nudge(9));
    wait_for(&status, "nudge pull", |_| {
        t.pulls.load(Ordering::SeqCst) > pulls_before
    });
    runner.stop();
}
