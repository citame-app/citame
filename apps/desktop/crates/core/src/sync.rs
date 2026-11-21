//! Sync engine: push the outbox serially, pull with the cursor, per docs/sync-protocol.md.

use std::{collections::BTreeMap, time::Duration};

use thiserror::Error;

use crate::error::CoreError;
use crate::model::*;
use crate::store::{INITIAL_GENERATION, Store};

pub const PUSH_BATCH: usize = 100;
// Leave headroom below the server's default one-MiB request limit.
const PUSH_JSON_BYTES: usize = 900 * 1024;
pub const PULL_PAGE: u32 = 200;
pub type CatalogColors = BTreeMap<String, String>;
pub(crate) const CATALOG_COLORS_CACHED: &str = "catalog_colors_cached";

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
    #[error("the server changed replica generation")]
    ReplicaGenerationChanged,
}

pub trait Transport: Send + Sync {
    fn push(&self, request: &PushRequest) -> Result<PushResponse, TransportError>;
    fn pull(&self, since: i64, limit: u32) -> Result<PullResponse, TransportError>;

    fn owner_salon_configuration(&self) -> Option<crate::http::ReviewedSalonConfiguration> {
        None
    }

    fn pull_with_catalog_colors(
        &self,
        since: i64,
        limit: u32,
    ) -> Result<(PullResponse, Option<CatalogColors>), TransportError> {
        Ok((self.pull(since, limit)?, None))
    }

    fn pull_with_catalogue(
        &self,
        since: i64,
        limit: u32,
        colors: bool,
        _full_resource_pools: bool,
    ) -> Result<(PullResponse, Option<CatalogColors>), TransportError> {
        if colors {
            self.pull_with_catalog_colors(since, limit)
        } else {
            self.pull(since, limit).map(|page| (page, None))
        }
    }
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
    #[error("the server changed replica generation")]
    ReplicaGenerationChanged,
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
        TransportError::ReplicaGenerationChanged => SyncError::ReplicaGenerationChanged,
    }
}

/// Sends the outbox head in batches of up to 100, one request at a time, in creation order.
pub fn push_outbox(store: &mut Store, transport: &dyn Transport) -> Result<PushReport, SyncError> {
    let mut report = PushReport::default();
    loop {
        let (generation, mut batch) = store.push_snapshot(PUSH_BATCH)?;
        if batch.is_empty() {
            return Ok(report);
        }
        let mut request = PushRequest {
            device_id: store.device_id()?,
            generation: Some(generation.clone()),
            mutations: Vec::with_capacity(batch.len()),
        };
        let mut bytes = serde_json::to_vec(&request).map_err(CoreError::from)?.len();
        for entry in &batch {
            let wire = entry.to_wire();
            bytes += serde_json::to_vec(&wire).map_err(CoreError::from)?.len() + 1;
            if bytes > PUSH_JSON_BYTES {
                break;
            }
            request.mutations.push(wire);
        }
        if request.mutations.is_empty() {
            let entry = &batch[0];
            let rejection = MutationResult::Rejected {
                mutation_id: entry.mutation_id.clone(),
                reason: "invalid".into(),
                message: "This change exceeds the maximum sync request size".into(),
                replayed: false,
            };
            store.apply_push_results_in(
                std::slice::from_ref(entry),
                &[rejection],
                Some(&generation),
                None,
            )?;
            report.rejected += 1;
            continue;
        }
        batch.truncate(request.mutations.len());
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
        let done = store.apply_push_results_in(
            &batch,
            &response.results,
            Some(&generation),
            Some(response.head_seq),
        )?;
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
    let mut generation = store.replica_generation()?;
    let mut switched_generation = false;
    let snapshot_complete = store.get_meta("calendar_snapshot_complete")?.is_some();
    let mut request_colors = store.get_meta(CATALOG_COLORS_CACHED)?.is_none();
    loop {
        let since = store.cursor()?;
        let response = transport.pull_with_catalogue(
            since,
            PULL_PAGE,
            request_colors,
            store.needs_resource_pool_snapshot()?,
        );
        let (page, colors) = match response {
            Ok(p) => p,
            Err(TransportError::CursorAhead) if !report.replica_reset => {
                // Restored server backup: our replica is from the future. Start over; the
                // outbox is the user's work and stays.
                store.reset_replica_in(Some(&generation))?;
                report.replica_reset = true;
                request_colors = true;
                continue;
            }
            Err(e) => return Err(classify(e)),
        };
        let server_generation = page.generation.as_deref().unwrap_or(INITIAL_GENERATION);
        if server_generation != generation {
            if switched_generation {
                return Err(SyncError::Retry(
                    "The server changed replica generation during sync".into(),
                ));
            }
            store.switch_replica_generation(&generation, server_generation)?;
            generation = server_generation.to_owned();
            switched_generation = true;
            report.replica_reset = true;
            request_colors = true;
            continue;
        }
        if store.apply_visibility_scopes(
            page.client_directory,
            page.calendar_scope.as_deref(),
            &generation,
        )? {
            if report.replica_reset {
                return Err(SyncError::Retry(
                    "Access changed while refreshing the replica".into(),
                ));
            }
            report.replica_reset = true;
            request_colors = true;
            continue;
        }
        if page.next_cursor < since {
            return Err(SyncError::Fatal(format!(
                "the server moved the cursor backwards ({since} -> {})",
                page.next_cursor
            )));
        }
        if page.has_more && page.next_cursor == since {
            return Err(SyncError::Fatal(
                "the server reports more changes but did not advance the cursor".into(),
            ));
        }
        let applied = store.apply_pulled_page(
            &page,
            snapshot_complete && !report.replica_reset,
            &generation,
        )?;
        if let Some(colors) = colors {
            store.apply_catalog_colors(&colors, Some(&generation))?;
        }
        request_colors = false;
        if let Some(scope) = page.time_off_scope.as_deref()
            && store.get_meta("time_off_scope")?.as_deref() != Some(scope)
        {
            store.set_meta_in("time_off_scope", scope, &generation)?;
        }
        report.pages += 1;
        report.changes += applied;
        if !page.has_more {
            break;
        }
    }
    report.cursor = store.cursor()?;
    Ok(report)
}

/// Push edits in the current history, then pull. A recovery fence stops the push before any
/// stale edit is applied. Pull then switches histories and preserves the edits as conflicts.
pub fn sync_cycle(store: &mut Store, transport: &dyn Transport) -> Result<CycleReport, SyncError> {
    let push = match push_outbox(store, transport) {
        Ok(push) => push,
        Err(SyncError::ReplicaGenerationChanged) => {
            let pull = pull_all(store, transport)?;
            if store.outbox_len()? != 0 {
                return Err(SyncError::Retry(
                    "The server has not finished switching replica generation".into(),
                ));
            }
            return Ok(CycleReport {
                push: PushReport::default(),
                pull,
            });
        }
        Err(error) => return Err(error),
    };
    let pull = pull_all(store, transport)?;
    Ok(CycleReport { push, pull })
}

#[cfg(test)]
mod tests;
