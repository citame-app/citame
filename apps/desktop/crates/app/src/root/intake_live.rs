use std::time::{Duration, Instant};

use sob_core::backoff::Backoff;

#[derive(Default)]
pub(super) struct LiveRefresh {
    loaded: Option<i64>,
    retry_at: Option<Instant>,
    backoff: Backoff,
}

impl LiveRefresh {
    pub(super) fn needs_refresh(&self, latest: i64, now: Instant) -> bool {
        self.loaded != Some(latest) && self.retry_at.is_none_or(|retry| now >= retry)
    }

    pub(super) fn acknowledge(&mut self, revision: Option<i64>) {
        self.loaded = revision;
        self.retry_at = None;
        self.backoff.reset();
    }

    pub(super) fn defer(&mut self, now: Instant, retry_after: Option<Duration>) {
        let delay = Backoff::at_least(
            self.backoff.next_delay().max(Duration::from_millis(500)),
            retry_after,
        );
        self.retry_at = Some(now + delay);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_transient_failure_preserves_the_marker_and_waits_before_retrying() {
        let now = Instant::now();
        let mut refresh = LiveRefresh::default();
        refresh.acknowledge(Some(13));
        assert!(refresh.needs_refresh(14, now));
        refresh.defer(now, Some(Duration::from_secs(2)));
        assert!(!refresh.needs_refresh(14, now));
        assert!(refresh.needs_refresh(14, now + Duration::from_secs(2)));
        refresh.acknowledge(Some(14));
        assert!(!refresh.needs_refresh(14, now));
        assert!(refresh.needs_refresh(15, now));
    }
}
