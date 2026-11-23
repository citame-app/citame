//! Confirmed room and equipment occupancy for one local day.
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::time::Duration;

use crate::auth::SessionHandle;
use crate::http::HttpTransport;
use crate::store::Store;
use crate::sync::TransportError;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceDay {
    pub from: DateTime<Utc>,
    pub to: DateTime<Utc>,
    pub resource_occupancy: Option<ResourceOccupancy>,
    #[serde(default)]
    pub appointments: Vec<ResourceAppointmentLabel>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceAppointmentLabel {
    pub id: String,
    pub client_name: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceOccupancy {
    pub captured_at: DateTime<Utc>,
    pub pools: Vec<ResourceColumn>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceColumn {
    pub id: String,
    pub name: String,
    pub capacity: u32,
    pub active: bool,
    pub windows: Vec<ReservedWindow>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReservedWindow {
    pub starts_at: DateTime<Utc>,
    pub ends_at: DateTime<Utc>,
    pub quantity: u32,
    pub appointment_id: Option<String>,
    pub hold_expires_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedResourceDay {
    pub(crate) day: ResourceDay,
    pub(crate) received_at: DateTime<Utc>,
}

impl CachedResourceDay {
    pub fn new(mut day: ResourceDay, received_at: DateTime<Utc>) -> Self {
        let linked: BTreeSet<_> = day
            .resource_occupancy
            .iter()
            .flat_map(|snapshot| &snapshot.pools)
            .flat_map(|pool| &pool.windows)
            .filter_map(|window| window.appointment_id.as_deref())
            .collect();
        day.appointments
            .retain(|booking| linked.contains(booking.id.as_str()));
        Self { day, received_at }
    }

    pub fn appointment_labels(&self) -> &[ResourceAppointmentLabel] {
        &self.day.appointments
    }

    pub fn occupancy(&self) -> Option<&ResourceOccupancy> {
        self.day.resource_occupancy.as_ref()
    }

    pub fn matches(&self, date: chrono::NaiveDate, timezone: chrono_tz::Tz) -> bool {
        let (from, to) = crate::calendar::local_day_range(timezone, date);
        self.day.from == from && self.day.to == to && self.occupancy().is_some()
    }

    pub fn elapsed_at(&self, now: DateTime<Utc>) -> chrono::Duration {
        now.signed_duration_since(self.received_at)
            .max(chrono::Duration::zero())
    }

    pub fn next_expiry(&self, elapsed: chrono::Duration) -> Option<chrono::Duration> {
        let occupancy = self.occupancy()?;
        occupancy
            .pools
            .iter()
            .flat_map(|column| &column.windows)
            .filter_map(|window| window.hold_expires_at)
            .map(|expiry| expiry - occupancy.captured_at)
            .filter(|remaining| *remaining > elapsed)
            .min()
    }

    pub fn rows(&self, elapsed: chrono::Duration) -> Vec<OccupancyRow> {
        let Some(occupancy) = self.occupancy() else {
            return Vec::new();
        };
        let now = occupancy
            .captured_at
            .checked_add_signed(elapsed)
            .unwrap_or(occupancy.captured_at);
        let mut changes: BTreeMap<_, Vec<_>> = BTreeMap::new();
        changes.entry(self.day.from).or_default();
        changes.entry(self.day.to).or_default();
        for (index, column) in occupancy.pools.iter().enumerate() {
            for window in &column.windows {
                if window.hold_expires_at.is_some_and(|expires| expires <= now) {
                    continue;
                }
                let start = self.day.from.max(window.starts_at);
                let end = self.day.to.min(window.ends_at);
                if start < end {
                    changes
                        .entry(start)
                        .or_default()
                        .push((index, true, window));
                    changes.entry(end).or_default().push((index, false, window));
                }
            }
        }
        let mut totals = vec![(0_u64, 0_u64); occupancy.pools.len()];
        let mut appointments = vec![BTreeMap::<&str, usize>::new(); occupancy.pools.len()];
        let mut rows = Vec::with_capacity(changes.len().saturating_sub(1));
        let mut points = changes.into_iter().peekable();
        while let Some((start, events)) = points.next() {
            let Some((end, _)) = points.peek() else { break };
            for (pool, added, window) in events {
                let (units, held) = &mut totals[pool];
                if added {
                    *units += u64::from(window.quantity);
                    if window.hold_expires_at.is_some() {
                        *held += u64::from(window.quantity);
                    }
                    if let Some(id) = window.appointment_id.as_deref() {
                        *appointments[pool].entry(id).or_default() += 1;
                    }
                } else {
                    *units -= u64::from(window.quantity);
                    if window.hold_expires_at.is_some() {
                        *held -= u64::from(window.quantity);
                    }
                    if let Some(id) = window.appointment_id.as_deref()
                        && let Some(count) = appointments[pool].get_mut(id)
                    {
                        *count -= 1;
                        if *count == 0 {
                            appointments[pool].remove(id);
                        }
                    }
                }
            }
            let cells = totals
                .iter()
                .zip(&appointments)
                .map(|(&(units, held), appointments)| OccupancyCell {
                    units,
                    held,
                    appointment_ids: appointments.keys().map(|id| (*id).to_owned()).collect(),
                })
                .collect();
            rows.push(OccupancyRow {
                start,
                end: *end,
                cells,
            });
        }
        rows
    }
}

#[derive(Debug)]
pub struct OccupancyRow {
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
    pub cells: Vec<OccupancyCell>,
}

#[derive(Debug)]
pub struct OccupancyCell {
    pub units: u64,
    pub held: u64,
    pub appointment_ids: Vec<String>,
}

pub enum Refresh {
    Loaded(CachedResourceDay),
    Denied,
    Unavailable,
    RetryAfter(Duration),
}

pub fn refresh(
    transport: &HttpTransport,
    replica: &Path,
    session: &SessionHandle,
    date: chrono::NaiveDate,
    timezone: chrono_tz::Tz,
    generation: &str,
) -> Refresh {
    const RETRY: Duration = Duration::from_secs(15);
    match transport.resource_day(date, timezone) {
        Ok(day) if day.resource_occupancy.is_some() => {
            let snapshot = CachedResourceDay::new(day, Utc::now());
            let Ok(mut store) = Store::open(replica) else {
                return Refresh::RetryAfter(RETRY);
            };
            // Check the session after acquiring the SQLite write lock.
            match store.cache_resource_day(date, generation, &snapshot, || {
                session.read().expect("session lock").is_some()
            }) {
                Ok(true) => Refresh::Loaded(snapshot),
                Ok(false) => Refresh::Unavailable,
                Err(_) => Refresh::RetryAfter(RETRY),
            }
        }
        Ok(_) => Refresh::Unavailable,
        Err(TransportError::Forbidden(_) | TransportError::Unauthorized) => {
            if let Ok(mut store) = Store::open(replica) {
                let _ = store.clear_resource_days(generation);
            }
            Refresh::Denied
        }
        Err(TransportError::RateLimited(Some(delay))) => Refresh::RetryAfter(delay.max(RETRY)),
        Err(_) => Refresh::RetryAfter(RETRY),
    }
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;

    use super::*;

    #[test]
    fn capacity_uses_end_exclusive_windows_and_expires_holds_from_server_time() {
        let at = |hour| Utc.with_ymd_and_hms(2026, 3, 9, hour, 0, 0).unwrap();
        let day = CachedResourceDay::new(
            ResourceDay {
                from: at(0),
                to: at(23),
                appointments: Vec::new(),
                resource_occupancy: Some(ResourceOccupancy {
                    captured_at: at(8),
                    pools: vec![ResourceColumn {
                        id: "room".into(),
                        name: "Room".into(),
                        capacity: 2,
                        active: true,
                        windows: vec![
                            ReservedWindow {
                                starts_at: at(12),
                                ends_at: at(13),
                                quantity: 2,
                                appointment_id: Some("appointment".into()),
                                hold_expires_at: None,
                            },
                            ReservedWindow {
                                starts_at: at(13),
                                ends_at: at(14),
                                quantity: 1,
                                appointment_id: None,
                                hold_expires_at: Some(at(9)),
                            },
                        ],
                    }],
                }),
            },
            at(10),
        );
        let elapsed = day.elapsed_at(at(10));
        assert_eq!(day.next_expiry(elapsed), Some(chrono::Duration::hours(1)));
        let rows = day.rows(elapsed);
        assert_eq!(
            rows.iter()
                .map(|row| row.cells[0].units)
                .collect::<Vec<_>>(),
            [0, 2, 1, 0]
        );
        assert_eq!(rows[1].cells[0].appointment_ids, ["appointment"]);
        assert!(rows[2].cells[0].appointment_ids.is_empty());
        assert_eq!(rows[2].cells[0].held, 1);
        let at_expiry = day.elapsed_at(at(11));
        assert_eq!(day.next_expiry(at_expiry), None);
        assert_eq!(
            day.rows(at_expiry)
                .iter()
                .map(|row| row.cells[0].units)
                .collect::<Vec<_>>(),
            [0, 2, 0]
        );
    }
}
