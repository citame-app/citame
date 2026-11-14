//! Exponential backoff with full jitter: base 1 s, factor 2, cap 60 s (docs/sync-protocol.md).

use std::time::Duration;

#[derive(Debug, Clone)]
pub struct Backoff {
    base: Duration,
    factor: u32,
    cap: Duration,
    failures: u32,
}

impl Default for Backoff {
    fn default() -> Self {
        Self::new(Duration::from_secs(1), 2, Duration::from_secs(60))
    }
}

impl Backoff {
    pub fn new(base: Duration, factor: u32, cap: Duration) -> Self {
        Self {
            base,
            factor,
            cap,
            failures: 0,
        }
    }

    pub fn failures(&self) -> u32 {
        self.failures
    }

    /// Upper bound of the next delay (before jitter).
    pub fn ceiling(&self) -> Duration {
        let mult = (self.factor as u64).saturating_pow(self.failures.min(32));
        let ms = (self.base.as_millis() as u64).saturating_mul(mult);
        Duration::from_millis(ms).min(self.cap)
    }

    /// Delay for the next retry given a uniform random `unit` in `[0, 1)`; counts one failure.
    pub fn next_delay_with(&mut self, unit: f64) -> Duration {
        let delay = self.ceiling().mul_f64(unit.clamp(0.0, 0.999_999));
        self.failures = self.failures.saturating_add(1);
        delay
    }

    pub fn next_delay(&mut self) -> Duration {
        let mut buf = [0u8; 8];
        getrandom::fill(&mut buf).expect("system randomness");
        let unit = (u64::from_le_bytes(buf) >> 11) as f64 / (1u64 << 53) as f64;
        self.next_delay_with(unit)
    }

    /// Never wait less than the server asked for (`Retry-After`).
    pub fn at_least(delay: Duration, retry_after: Option<Duration>) -> Duration {
        retry_after.map_or(delay, |floor| delay.max(floor))
    }

    pub fn reset(&mut self) {
        self.failures = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ceiling_doubles_from_one_second_up_to_the_cap() {
        let mut b = Backoff::default();
        let mut ceilings = vec![];
        for _ in 0..9 {
            ceilings.push(b.ceiling().as_secs());
            b.next_delay_with(0.5);
        }
        assert_eq!(ceilings, vec![1, 2, 4, 8, 16, 32, 60, 60, 60]);
    }

    #[test]
    fn full_jitter_spans_zero_to_ceiling() {
        let mut b = Backoff::default();
        b.next_delay_with(0.0);
        b.next_delay_with(0.0); // ceiling is now 4 s
        assert_eq!(b.clone().next_delay_with(0.0), Duration::ZERO);
        assert_eq!(b.clone().next_delay_with(0.5), Duration::from_secs(2));
        assert!(b.next_delay_with(0.999) < Duration::from_secs(4));
    }

    #[test]
    fn reset_starts_over_after_a_success() {
        let mut b = Backoff::default();
        for _ in 0..5 {
            b.next_delay_with(0.5);
        }
        assert_eq!(b.failures(), 5);
        b.reset();
        assert_eq!(b.ceiling(), Duration::from_secs(1));
    }

    #[test]
    fn retry_after_is_a_floor() {
        let d = Duration::from_secs(2);
        assert_eq!(
            Backoff::at_least(d, Some(Duration::from_secs(30))),
            Duration::from_secs(30)
        );
        assert_eq!(Backoff::at_least(d, Some(Duration::from_secs(1))), d);
        assert_eq!(Backoff::at_least(d, None), d);
    }

    #[test]
    fn random_delay_stays_within_bounds() {
        let mut b = Backoff::default();
        for _ in 0..50 {
            let c = b.ceiling();
            assert!(b.next_delay() <= c);
        }
    }
}
