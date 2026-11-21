//! Background sync: one worker thread that cycles on wake-ups (local edit, SSE nudge, timer)
//! and publishes a `SyncStatus` for the UI. Failures back off exponentially with full jitter.

use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};

use crate::backoff::Backoff;
use crate::calendar;
use crate::store::Store;
use crate::sync::{self, SyncError, Transport};

pub const POLL_INTERVAL: Duration = Duration::from_secs(60);
/// While the session is gone there is nothing to retry until the user signs in again.
pub const AUTH_WAIT: Duration = Duration::from_secs(3600);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Connectivity {
    /// No attempt has finished yet.
    Connecting,
    Online,
    Offline,
    AuthRequired,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SyncStatus {
    pub connectivity: Connectivity,
    pub syncing: bool,
    pub last_sync_at: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
    pub pending: usize,
    pub conflicts: usize,
    pub cursor: i64,
    /// True while the SSE stream is connected (otherwise the 60 s poll is the safety net).
    pub stream_live: bool,
    pub retry_in: Option<Duration>,
}

impl Default for SyncStatus {
    fn default() -> Self {
        Self {
            connectivity: Connectivity::Connecting,
            syncing: false,
            last_sync_at: None,
            last_error: None,
            pending: 0,
            conflicts: 0,
            cursor: 0,
            stream_live: false,
            retry_in: None,
        }
    }
}

pub type SharedStatus = Arc<Mutex<SyncStatus>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Wake {
    /// The user changed something locally.
    Local,
    /// "Sync now" or a reconnect.
    Manual,
    /// The server announced a change at `seq`.
    Nudge(i64),
    Stop,
}

/// The synchronous heart of the runner: one cycle, one status update, the next wait.
pub struct RunnerCore {
    store: Store,
    transport: Arc<dyn Transport>,
    backoff: Backoff,
    rate_limited: bool,
    jitter: Box<dyn FnMut() -> f64 + Send>,
    status: SharedStatus,
}

impl RunnerCore {
    pub fn new(store: Store, transport: Arc<dyn Transport>, status: SharedStatus) -> Self {
        let mut core = Self {
            store,
            transport,
            backoff: Backoff::default(),
            rate_limited: false,
            jitter: Box::new(|| {
                let mut buf = [0u8; 8];
                getrandom::fill(&mut buf).expect("system randomness");
                (u64::from_le_bytes(buf) >> 11) as f64 / (1u64 << 53) as f64
            }),
            status,
        };
        core.refresh_counts();
        core
    }

    fn refresh_counts(&mut self) {
        let summary = calendar::sync_summary(&self.store).unwrap_or_default();
        let mut s = self.status.lock().expect("status lock");
        s.pending = summary.pending;
        s.conflicts = summary.conflicts;
        s.cursor = summary.cursor;
    }

    fn update(&self, f: impl FnOnce(&mut SyncStatus)) {
        f(&mut self.status.lock().expect("status lock"));
    }

    /// Replaces the random jitter source (tests).
    pub fn with_jitter(mut self, jitter: impl FnMut() -> f64 + Send + 'static) -> Self {
        self.jitter = Box::new(jitter);
        self
    }

    /// Runs one sync cycle and returns how long to wait before the next one.
    pub fn run_cycle(&mut self) -> Duration {
        self.update(|s| s.syncing = true);
        let result = sync::sync_cycle(&mut self.store, &*self.transport);
        self.rate_limited = false;
        self.refresh_counts();
        let wait = match result {
            Ok(_) => {
                // Older replicas may already be past the most recent settings upsert.
                if self
                    .store
                    .cached_salon_configuration()
                    .is_ok_and(|saved| saved.is_none())
                    && let Some(settings) = self.transport.owner_salon_configuration()
                {
                    let _ = self.store.cache_salon_configuration(&settings);
                }
                self.backoff.reset();
                self.update(|s| {
                    s.connectivity = Connectivity::Online;
                    s.last_sync_at = Some(Utc::now());
                    s.last_error = None;
                    s.retry_in = None;
                });
                POLL_INTERVAL
            }
            Err(error @ (SyncError::AuthRequired | SyncError::Forbidden(_))) => {
                let e = error.to_string();
                self.update(|s| {
                    s.connectivity = Connectivity::AuthRequired;
                    s.last_error = Some(e);
                    s.retry_in = None;
                });
                AUTH_WAIT
            }
            Err(e) => {
                let (connectivity, wait) = match &e {
                    SyncError::Fatal(_) => (Connectivity::Online, POLL_INTERVAL),
                    _ => {
                        let (connectivity, retry_after) = match &e {
                            SyncError::RateLimited(after) => {
                                self.rate_limited = true;
                                (Connectivity::Offline, *after)
                            }
                            SyncError::Offline(_) => (Connectivity::Offline, None),
                            _ => (Connectivity::Online, None),
                        };
                        let jittered = self.backoff.next_delay_with((self.jitter)());
                        (connectivity, Backoff::at_least(jittered, retry_after))
                    }
                };
                let msg = e.to_string();
                self.update(|s| {
                    s.connectivity = connectivity;
                    s.last_error = Some(msg);
                    s.retry_in = e.is_transient().then_some(wait);
                });
                wait
            }
        };
        self.update(|s| s.syncing = false);
        wait
    }

    /// A nudge only matters when the server is ahead of us.
    pub fn nudge_is_news(&self, seq: i64) -> bool {
        seq > self.store.cursor().unwrap_or(0) || self.store.outbox_len().unwrap_or(0) > 0
    }
}

pub struct SyncRunner {
    tx: Sender<Wake>,
    status: SharedStatus,
    handle: Option<JoinHandle<()>>,
}

impl SyncRunner {
    pub fn spawn(mut core: RunnerCore) -> Self {
        let (tx, rx) = mpsc::channel::<Wake>();
        let status = core.status.clone();
        let handle = std::thread::Builder::new()
            .name("sob-sync".into())
            .spawn(move || {
                let mut deadline = Instant::now();
                'outer: loop {
                    let timeout = deadline.saturating_duration_since(Instant::now());
                    match rx.recv_timeout(timeout) {
                        Ok(Wake::Stop) | Err(RecvTimeoutError::Disconnected) => break,
                        // Edits remain in SQLite and the scheduled cycle pulls from its cursor.
                        Ok(_) if core.rate_limited && Instant::now() < deadline => continue,
                        Ok(Wake::Nudge(seq)) if !core.nudge_is_news(seq) => continue,
                        Ok(_) | Err(RecvTimeoutError::Timeout) => {}
                    }
                    // Coalesce a burst of wake-ups into one cycle.
                    while let Ok(w) = rx.try_recv() {
                        if w == Wake::Stop {
                            break 'outer;
                        }
                    }
                    let wait = core.run_cycle();
                    deadline = Instant::now() + wait;
                }
            })
            .expect("spawn sync thread");
        Self {
            tx,
            status,
            handle: Some(handle),
        }
    }

    pub fn sender(&self) -> Sender<Wake> {
        self.tx.clone()
    }

    pub fn wake(&self, why: Wake) {
        let _ = self.tx.send(why);
    }

    pub fn status(&self) -> SyncStatus {
        self.status.lock().expect("status lock").clone()
    }

    pub fn shared_status(&self) -> SharedStatus {
        self.status.clone()
    }

    pub fn stop(mut self) {
        let _ = self.tx.send(Wake::Stop);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

impl Drop for SyncRunner {
    fn drop(&mut self) {
        let _ = self.tx.send(Wake::Stop);
    }
}

#[cfg(test)]
mod tests;
