use serde::{Deserialize, Serialize};

use crate::billing::parse_reviewed_amount;
use crate::sync::TransportError;

pub const LIVE_TOPIC: &str = "booking_policy";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DepositKind {
    Percent,
    Fixed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookingPolicy {
    pub enabled: bool,
    pub deposit_kind: DepositKind,
    pub deposit_value: u32,
    pub hold_minutes: u32,
    pub cancellation_window_minutes: u32,
    pub late_cancellation_basis_points: u32,
    pub no_show_basis_points: u32,
    pub trusted_exempt: bool,
    pub version: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewedBookingPolicy {
    pub generation: String,
    pub policy: BookingPolicy,
}

#[derive(Clone, PartialEq, Eq)]
pub struct PolicyInput {
    pub enabled: bool,
    pub deposit_kind: DepositKind,
    pub deposit_value: String,
    pub hold_minutes: String,
    pub cancellation_window_minutes: String,
    pub late_fee: String,
    pub no_show_fee: String,
    pub trusted_exempt: bool,
}

impl PolicyInput {
    pub fn validated(self, version: u32) -> Option<BookingPolicy> {
        let maximum = match self.deposit_kind {
            DepositKind::Percent => 10_000,
            DepositKind::Fixed => 999_999_999,
        };
        Some(BookingPolicy {
            enabled: self.enabled,
            deposit_kind: self.deposit_kind,
            deposit_value: within(parse_reviewed_amount(&self.deposit_value)?, 1, maximum)?,
            hold_minutes: within(self.hold_minutes.trim().parse().ok()?, 5, 60)?,
            cancellation_window_minutes: within(
                self.cancellation_window_minutes.trim().parse().ok()?,
                0,
                43_200,
            )?,
            late_cancellation_basis_points: within(
                parse_reviewed_amount(&self.late_fee)?,
                0,
                10_000,
            )?,
            no_show_basis_points: within(parse_reviewed_amount(&self.no_show_fee)?, 0, 10_000)?,
            trusted_exempt: self.trusted_exempt,
            version,
        })
    }
}

fn within(value: u32, min: u32, max: u32) -> Option<u32> {
    (min..=max).contains(&value).then_some(value)
}

impl PolicyInput {
    pub fn from_policy(policy: &BookingPolicy) -> Self {
        let scaled = |amount: u32| format!("{}.{:02}", amount / 100, amount % 100);
        Self {
            enabled: policy.enabled,
            deposit_kind: policy.deposit_kind,
            deposit_value: scaled(policy.deposit_value),
            hold_minutes: policy.hold_minutes.to_string(),
            cancellation_window_minutes: policy.cancellation_window_minutes.to_string(),
            late_fee: scaled(policy.late_cancellation_basis_points),
            no_show_fee: scaled(policy.no_show_basis_points),
            trusted_exempt: policy.trusted_exempt,
        }
    }

    pub fn rebase(self, baseline: &BookingPolicy, latest: &BookingPolicy) -> Self {
        fn field(
            edited: String,
            baseline: String,
            current: String,
            parse: fn(&str) -> Option<u32>,
        ) -> String {
            if same_value(&edited, &baseline, parse) {
                current
            } else {
                edited
            }
        }
        fn minutes(input: &str) -> Option<u32> {
            input.trim().parse().ok()
        }

        let old = Self::from_policy(baseline);
        let current = Self::from_policy(latest);
        let keep_deposit = self.deposit_kind != old.deposit_kind
            || !same_value(
                &self.deposit_value,
                &old.deposit_value,
                parse_reviewed_amount,
            );
        Self {
            enabled: if self.enabled == old.enabled {
                current.enabled
            } else {
                self.enabled
            },
            deposit_kind: if keep_deposit {
                self.deposit_kind
            } else {
                current.deposit_kind
            },
            deposit_value: if keep_deposit {
                self.deposit_value
            } else {
                current.deposit_value
            },
            hold_minutes: field(
                self.hold_minutes,
                old.hold_minutes,
                current.hold_minutes,
                minutes,
            ),
            cancellation_window_minutes: field(
                self.cancellation_window_minutes,
                old.cancellation_window_minutes,
                current.cancellation_window_minutes,
                minutes,
            ),
            late_fee: field(
                self.late_fee,
                old.late_fee,
                current.late_fee,
                parse_reviewed_amount,
            ),
            no_show_fee: field(
                self.no_show_fee,
                old.no_show_fee,
                current.no_show_fee,
                parse_reviewed_amount,
            ),
            trusted_exempt: if self.trusted_exempt == old.trusted_exempt {
                current.trusted_exempt
            } else {
                self.trusted_exempt
            },
        }
    }
}

fn same_value(a: &str, b: &str, parse: fn(&str) -> Option<u32>) -> bool {
    a == b || parse(a).is_some_and(|value| parse(b) == Some(value))
}

#[derive(Debug, thiserror::Error)]
pub enum PolicyWriteError {
    #[error("The reviewed booking policy changed")]
    Conflict,
    #[error("Active services must use EUR before enabling booking deposits")]
    MixedCurrencies,
    #[error(transparent)]
    Transport(#[from] TransportError),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policy_amounts_are_exact_and_rebase_a_deposit_as_one_term() {
        let input = || PolicyInput {
            enabled: false,
            deposit_kind: DepositKind::Percent,
            deposit_value: "25,50".into(),
            hold_minutes: "15".into(),
            cancellation_window_minutes: "1440".into(),
            late_fee: "10.05".into(),
            no_show_fee: "0".into(),
            trusted_exempt: true,
        };
        let saved = input().validated(1).unwrap();
        assert_eq!(saved.deposit_value, 2550);
        assert_eq!(saved.late_cancellation_basis_points, 1005);
        assert!(
            PolicyInput {
                deposit_value: "100,01".into(),
                ..input()
            }
            .validated(1)
            .is_none()
        );
        let current = BookingPolicy {
            deposit_kind: DepositKind::Fixed,
            deposit_value: 5000,
            hold_minutes: 25,
            version: 2,
            ..saved.clone()
        };
        let mut draft = PolicyInput::from_policy(&saved);
        draft.deposit_value = "30".into();
        let reviewed = draft
            .rebase(&saved, &current)
            .validated(current.version)
            .unwrap();
        assert_eq!(
            (reviewed.deposit_kind, reviewed.deposit_value),
            (DepositKind::Percent, 3000)
        );
        assert_eq!((reviewed.hold_minutes, reviewed.version), (25, 2));
        let mut incomplete = PolicyInput::from_policy(&saved);
        incomplete.deposit_value = "25,5".into();
        incomplete.no_show_fee = "15,".into();
        let rebased = incomplete.rebase(&saved, &current);
        assert_eq!(rebased.deposit_kind, DepositKind::Fixed);
        assert_eq!(rebased.hold_minutes, "25");
        assert_eq!(rebased.no_show_fee, "15,");
    }
}
