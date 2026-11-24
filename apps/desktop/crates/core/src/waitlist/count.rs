use std::sync::Arc;
use std::time::{Duration, Instant};

use super::{WaitlistRange, WaitlistView};
use crate::store::{CalendarCacheScope, Store};
use crate::sync::TransportError;

const REFRESH_INTERVAL: Duration = Duration::from_secs(15);

#[derive(Default)]
pub struct WaitlistCount {
    query: Option<(WaitlistRange, CalendarCacheScope)>,
    total: Option<u32>,
    revision: Option<i64>,
    requested_at: Option<Instant>,
    pending: Option<Arc<()>>,
}

pub struct CountRequest {
    pub range: WaitlistRange,
    scope: CalendarCacheScope,
    identity: Arc<()>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum WaitlistCountUpdate {
    Unchanged,
    DisplayChanged,
    AccessDenied,
}

impl WaitlistCount {
    pub fn total_for(&self, range: WaitlistRange) -> Option<u32> {
        self.query
            .as_ref()
            .filter(|(shown, _)| *shown == range)
            .and(self.total)
    }

    pub fn refresh(
        &mut self,
        store: &Store,
        range: Option<WaitlistRange>,
        online: bool,
        now: Instant,
    ) -> (Option<CountRequest>, bool) {
        let query = range.and_then(|range| {
            store
                .calendar_cache_scope()
                .ok()
                .map(|scope| (range, scope))
        });
        let changed = self.query != query;
        if changed {
            *self = Self {
                total: query.as_ref().and_then(|(range, scope)| {
                    store
                        .waitlist_cache(WaitlistView::Calendar(*range), 1)
                        .ok()
                        .filter(|saved| saved.scope.as_ref() == Some(scope))
                        .and_then(|saved| saved.current.map(|page| page.total))
                }),
                query,
                ..Default::default()
            };
        }
        if !online {
            self.requested_at = None;
            self.pending = None;
            return (None, changed);
        }
        let Some((range, scope)) = &self.query else {
            return (None, changed);
        };
        let revision = store.live_view_revision("waitlist").ok();
        if self.pending.is_some()
            || (self.revision == revision
                && self
                    .requested_at
                    .is_some_and(|last| now.saturating_duration_since(last) < REFRESH_INTERVAL))
        {
            return (None, changed);
        }
        let identity = Arc::new(());
        self.pending = Some(identity.clone());
        self.revision = revision;
        self.requested_at = Some(now);
        (
            Some(CountRequest {
                range: *range,
                scope: scope.clone(),
                identity,
            }),
            changed,
        )
    }

    pub fn apply(
        &mut self,
        store: &mut Store,
        range: Option<WaitlistRange>,
        request: CountRequest,
        result: Result<u32, TransportError>,
    ) -> WaitlistCountUpdate {
        let current_scope = store.calendar_cache_scope().ok();
        // Access to the waitlist applies to every period. An older request from this same
        // scope can report a denial after navigating or going offline.
        if matches!(
            &result,
            Err(TransportError::Unauthorized | TransportError::Forbidden(_))
        ) && current_scope.as_ref() == Some(&request.scope)
        {
            self.deny(store);
            return WaitlistCountUpdate::AccessDenied;
        }
        if !self
            .pending
            .as_ref()
            .is_some_and(|pending| Arc::ptr_eq(pending, &request.identity))
        {
            return WaitlistCountUpdate::Unchanged;
        }
        self.pending = None;
        if range != Some(request.range) || current_scope.as_ref() != Some(&request.scope) {
            return WaitlistCountUpdate::Unchanged;
        }
        match result {
            Ok(total) if self.total != Some(total) => {
                self.total = Some(total);
                WaitlistCountUpdate::DisplayChanged
            }
            _ => WaitlistCountUpdate::Unchanged,
        }
    }

    pub fn deny(&mut self, store: &mut Store) {
        self.total = None;
        self.pending = None;
        let _ = store.invalidate_waitlist_access();
        if let Some((_, scope)) = &mut self.query
            && let Ok(current) = store.calendar_cache_scope()
        {
            *scope = current;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::waitlist::{WaitlistPage, WaitlistPolicy};

    #[test]
    fn changing_period_and_losing_access_discards_old_counts_and_pages() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(&dir.path().join("waitlist-count.db")).unwrap();
        let scope = store.calendar_cache_scope().unwrap();
        let date: chrono::NaiveDate = "2026-03-10".parse().unwrap();
        let first = WaitlistRange {
            from: date,
            to: date,
        };
        let next = date.succ_opt().unwrap();
        let other = WaitlistRange {
            from: next,
            to: next,
        };
        let page = WaitlistPage {
            page: 1,
            page_size: 15,
            total: 3,
            policy: WaitlistPolicy {
                enabled: true,
                offer_minutes: 30,
                version: 1,
            },
            entries: vec![],
            imported: vec![],
        };
        store
            .cache_waitlist(&scope, WaitlistView::Calendar(first), &page)
            .unwrap();
        let now = Instant::now();
        let mut count = WaitlistCount::default();
        assert!(count.refresh(&store, Some(first), false, now).0.is_none());
        assert_eq!(count.total_for(first), Some(3));
        let old = count.refresh(&store, Some(first), true, now).0.unwrap();
        let fresh = count.refresh(&store, Some(other), true, now).0.unwrap();
        assert_eq!(
            count.apply(&mut store, Some(other), old, Ok(20)),
            WaitlistCountUpdate::Unchanged
        );
        assert_eq!(count.total_for(other), None);
        assert_eq!(
            count.apply(
                &mut store,
                Some(other),
                fresh,
                Err(TransportError::Unauthorized)
            ),
            WaitlistCountUpdate::AccessDenied,
        );
        assert!(count.refresh(&store, Some(other), true, now).0.is_none());
        assert!(
            store
                .waitlist_cache(WaitlistView::Calendar(first), 1)
                .unwrap()
                .current
                .is_none()
        );
        assert!(
            store
                .cache_waitlist(&scope, WaitlistView::Calendar(first), &page)
                .unwrap()
                .is_none()
        );
        let restored = count
            .refresh(&store, Some(other), true, now + REFRESH_INTERVAL)
            .0
            .unwrap();
        assert_eq!(
            count.apply(&mut store, Some(other), restored, Ok(2)),
            WaitlistCountUpdate::DisplayChanged
        );
        store.set_meta("live_view:waitlist", "1").unwrap();
        let previous_period = count
            .refresh(&store, Some(other), true, now + REFRESH_INTERVAL)
            .0
            .unwrap();
        let scope = store.calendar_cache_scope().unwrap();
        store
            .cache_waitlist(&scope, WaitlistView::Calendar(first), &page)
            .unwrap();
        count.refresh(&store, Some(first), false, now + REFRESH_INTERVAL);
        assert_eq!(count.total_for(first), Some(3));
        assert_eq!(
            count.apply(
                &mut store,
                Some(first),
                previous_period,
                Err(TransportError::Unauthorized)
            ),
            WaitlistCountUpdate::AccessDenied,
        );
        assert_eq!(count.total_for(first), None);
        assert!(
            store
                .waitlist_cache(WaitlistView::Calendar(first), 1)
                .unwrap()
                .current
                .is_none()
        );
    }
}
