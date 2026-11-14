//! Sync engine: push the outbox serially, pull with the cursor, per docs/sync-protocol.md.

use std::time::Duration;

use thiserror::Error;

use crate::error::CoreError;
use crate::model::*;
use crate::store::Store;

pub const PUSH_BATCH: usize = 100;
pub const PULL_PAGE: u32 = 200;

/// What a transport can tell the engine; classification follows the protocol's error table.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum TransportError {
    /// No connection, timeout, DNS failure: resend the same batch later.
    #[error("offline: {0}")]
    Offline(String),
    /// 5xx without a usable body: resend the same batch with backoff.
    #[error("server error: {0}")]
    Server(String),
    /// 429: honor `Retry-After`.
    #[error("rate limited")]
    RateLimited(Option<Duration>),
    /// 401: the session is gone; sign in again.
    #[error("unauthorized")]
    Unauthorized,
    /// 403: never retried.
    #[error("forbidden: {0}")]
    Forbidden(String),
    /// 400: a client bug; never retried.
    #[error("bad request: {0}")]
    BadRequest(String),
    /// 409 on pull: the cursor is ahead of the server (restored backup).
    #[error("cursor ahead of server")]
    CursorAhead,
}

pub trait Transport: Send + Sync {
    fn push(&self, request: &PushRequest) -> Result<PushResponse, TransportError>;
    fn pull(&self, since: i64, limit: u32) -> Result<PullResponse, TransportError>;
}

#[derive(Debug, Error)]
pub enum SyncError {
    #[error("offline: {0}")]
    Offline(String),
    #[error("rate limited")]
    RateLimited(Option<Duration>),
    #[error("the session expired, sign in again")]
    AuthRequired,
    #[error("not allowed: {0}")]
    Forbidden(String),
    /// The server asked to resend (`status: retry`); nothing was lost.
    #[error("server asked to retry: {0}")]
    Retry(String),
    #[error("{0}")]
    Fatal(String),
    #[error(transparent)]
    Core(#[from] CoreError),
}

impl SyncError {
    /// Worth trying again later with backoff (as opposed to needing the user).
    pub fn is_transient(&self) -> bool {
        matches!(
            self,
            Self::Offline(_) | Self::RateLimited(_) | Self::Retry(_)
        )
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct PushReport {
    pub batches: usize,
    pub applied: usize,
    pub rejected: usize,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct PullReport {
    pub pages: usize,
    pub changes: usize,
    pub cursor: i64,
    pub replica_reset: bool,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct CycleReport {
    pub push: PushReport,
    pub pull: PullReport,
}

fn classify(e: TransportError) -> SyncError {
    match e {
        TransportError::Offline(m) | TransportError::Server(m) => SyncError::Offline(m),
        TransportError::RateLimited(after) => SyncError::RateLimited(after),
        TransportError::Unauthorized => SyncError::AuthRequired,
        TransportError::Forbidden(m) => SyncError::Forbidden(m),
        TransportError::BadRequest(m) => {
            SyncError::Fatal(format!("the server rejected the request: {m}"))
        }
        TransportError::CursorAhead => SyncError::Fatal("unexpected cursor conflict".into()),
    }
}

/// Sends the outbox head in batches of up to 100, one request at a time, in creation order.
pub fn push_outbox(store: &mut Store, transport: &dyn Transport) -> Result<PushReport, SyncError> {
    let mut report = PushReport::default();
    loop {
        let batch = store.outbox(PUSH_BATCH)?;
        if batch.is_empty() {
            return Ok(report);
        }
        let request = PushRequest {
            device_id: store.device_id()?,
            mutations: batch.iter().map(OutboxEntry::to_wire).collect(),
        };
        let response = match transport.push(&request) {
            Ok(r) => r,
            Err(e) => {
                let counts = matches!(
                    e,
                    TransportError::Offline(_)
                        | TransportError::Server(_)
                        | TransportError::RateLimited(_)
                );
                if counts {
                    let ids: Vec<String> = batch.iter().map(|m| m.mutation_id.clone()).collect();
                    store.record_failure(&ids, &e.to_string())?;
                }
                return Err(classify(e));
            }
        };
        let done = store.apply_push_results(&batch, &response.results)?;
        report.batches += 1;
        report.applied += done.applied;
        report.rejected += done.rejected;
        if done.retry_pending {
            let msg = response
                .results
                .iter()
                .find_map(|r| match r {
                    MutationResult::Retry { message, .. } => Some(message.clone()),
                    _ => None,
                })
                .unwrap_or_default();
            return Err(SyncError::Retry(msg));
        }
    }
}

/// Pulls until the log is drained, applying each page together with its cursor.
pub fn pull_all(store: &mut Store, transport: &dyn Transport) -> Result<PullReport, SyncError> {
    let mut report = PullReport::default();
    loop {
        let since = store.cursor()?;
        let page = match transport.pull(since, PULL_PAGE) {
            Ok(p) => p,
            Err(TransportError::CursorAhead) if !report.replica_reset => {
                // Restored server backup: our replica is from the future. Start over; the
                // outbox is the user's work and stays.
                store.reset_replica()?;
                report.replica_reset = true;
                continue;
            }
            Err(e) => return Err(classify(e)),
        };
        if page.next_cursor < since {
            return Err(SyncError::Fatal(format!(
                "the server moved the cursor backwards ({since} -> {})",
                page.next_cursor
            )));
        }
        store.apply_page(&page.changes, page.next_cursor)?;
        report.pages += 1;
        report.changes += page.changes.len();
        if !page.has_more {
            break;
        }
        if page.next_cursor <= since {
            return Err(SyncError::Fatal(
                "the server reports more changes but did not advance the cursor".into(),
            ));
        }
    }
    report.cursor = store.cursor()?;
    Ok(report)
}

/// Push first, then pull (the pull then shows the effect of our own mutations).
pub fn sync_cycle(store: &mut Store, transport: &dyn Transport) -> Result<CycleReport, SyncError> {
    let push = push_outbox(store, transport)?;
    let pull = pull_all(store, transport)?;
    Ok(CycleReport { push, pull })
}

#[cfg(test)]
mod tests;
