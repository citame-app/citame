use chrono::DateTime;
use rusqlite::{OptionalExtension, Row, Transaction, params};

use super::Store;
use crate::error::{CoreError, Result};
use crate::model::{Appointment, AppointmentStatus, CalendarNoticeKind, OutboxEntry};

impl CalendarNoticeKind {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::New => "new",
            Self::Rescheduled => "rescheduled",
            Self::Cancelled => "cancelled",
        }
    }

    fn parse(value: &str) -> Result<Self> {
        match value {
            "new" => Ok(Self::New),
            "rescheduled" => Ok(Self::Rescheduled),
            "cancelled" => Ok(Self::Cancelled),
            _ => Err(CoreError::Protocol("Unknown calendar notice kind".into())),
        }
    }
}

pub(super) enum NoticeUpdate {
    Show(CalendarNoticeKind),
    Clear,
}

struct Position {
    version: i64,
    status: String,
    staff_id: Option<String>,
    starts_at_ms: Option<i64>,
}

impl Position {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            version: row.get(0)?,
            status: row.get(1)?,
            staff_id: row.get(2)?,
            starts_at_ms: row.get(3)?,
        })
    }

    fn has_moved(&self, appointment: &Appointment) -> bool {
        self.staff_id
            .as_ref()
            .is_some_and(|staff| staff != &appointment.staff_id)
            || self
                .starts_at_ms
                .is_some_and(|start| start != appointment.starts_at.timestamp_millis())
    }
}

fn mirrored_position(tx: &Transaction, id: &str) -> Result<Option<Position>> {
    Ok(tx
        .query_row(
            "SELECT version,status,staff_id,starts_at_ms FROM appointment WHERE id=?1",
            [id],
            Position::from_row,
        )
        .optional()?)
}

fn local_position(tx: &Transaction, id: &str, through_version: i64) -> Result<Option<Position>> {
    Ok(tx
        .query_row(
            "SELECT version,status,staff_id,starts_at_ms FROM local_calendar_ack
         WHERE appointment_id=?1 AND version<=?2 ORDER BY version DESC LIMIT 1",
            params![id, through_version],
            Position::from_row,
        )
        .optional()?)
}

pub(super) fn remember_applied(tx: &Transaction, entry: &OutboxEntry, seq: i64) -> Result<()> {
    let Some(reviewed_version) = entry.payload["version"].as_i64() else {
        return Ok(());
    };
    let Some(version) = reviewed_version.checked_add(1) else {
        return Ok(());
    };
    let reviewed = match local_position(tx, &entry.entity_id, reviewed_version)? {
        Some(position) if position.version == reviewed_version => Some(position),
        _ => mirrored_position(tx, &entry.entity_id)?.filter(|p| p.version == reviewed_version),
    };
    let staff_id = entry.payload["staffId"]
        .as_str()
        .or_else(|| reviewed.as_ref().and_then(|p| p.staff_id.as_deref()));
    let starts_at_ms = entry.payload["startsAt"]
        .as_str()
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|date| date.timestamp_millis())
        .or_else(|| reviewed.as_ref().and_then(|p| p.starts_at_ms));
    let status = if entry.kind == "appointment.cancel" {
        AppointmentStatus::Cancelled
    } else {
        AppointmentStatus::Booked
    };
    tx.execute(
        "INSERT OR IGNORE INTO local_calendar_ack (seq,appointment_id,version,status,staff_id,starts_at_ms)
         VALUES (?1,?2,?3,?4,?5,?6)",
        params![seq, entry.entity_id, version, status.as_str(), staff_id, starts_at_ms],
    )?;
    Ok(())
}

pub(super) fn classify(
    tx: &Transaction,
    appointment: &Appointment,
) -> Result<Option<NoticeUpdate>> {
    if let Some(previous) = mirrored_position(tx, &appointment.id)? {
        if appointment.version <= previous.version {
            return Ok(None);
        }
        // Pull returns the current row, which can be newer than its sequence
        // or appear at a later sequence after re-announcement. Compare against
        // an acknowledged local position when the mirror has not seen it yet.
        let local = local_position(tx, &appointment.id, appointment.version)?
            .filter(|position| position.version > previous.version);
        let basis = local.as_ref().unwrap_or(&previous);
        if basis.version < appointment.version && basis.status == "booked" {
            let kind = match appointment.status {
                AppointmentStatus::Cancelled => Some(CalendarNoticeKind::Cancelled),
                AppointmentStatus::Booked if basis.has_moved(appointment) => {
                    Some(CalendarNoticeKind::Rescheduled)
                }
                _ => None,
            };
            if let Some(kind) = kind {
                return Ok(Some(NoticeUpdate::Show(kind)));
            }
        }
        return Ok(local.is_some().then_some(NoticeUpdate::Clear));
    }
    if appointment.status != AppointmentStatus::Booked
        || appointment.imported_from_booksy
        || appointment.visit_group_id.is_some()
    {
        return Ok(None);
    }
    let local: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM local_booking_confirmation WHERE appointment_id=?1
                       UNION ALL SELECT 1 FROM outbox WHERE entity_id=?1 AND kind='appointment.create')",
        [&appointment.id],
        |row| row.get(0),
    )?;
    if local {
        return Ok(None);
    }
    // A first-seen row in a restricted calendar is new to that professional's
    // agenda. Its current version alone cannot identify how it got there.
    let newly_visible = appointment.version == 1
        || Store::meta_at(tx, "calendar_scope")?.as_deref() == Some(&appointment.staff_id);
    Ok(newly_visible.then_some(NoticeUpdate::Show(CalendarNoticeKind::New)))
}

pub(super) fn apply(tx: &Transaction, id: &str, update: Option<NoticeUpdate>) -> Result<()> {
    match update {
        Some(NoticeUpdate::Show(kind)) => {
            tx.execute(
                "INSERT OR REPLACE INTO booking_notice (appointment_id,kind) VALUES (?1,?2)",
                params![id, kind.as_str()],
            )?;
        }
        Some(NoticeUpdate::Clear) => {
            tx.execute("DELETE FROM booking_notice WHERE appointment_id=?1", [id])?;
        }
        None => {}
    }
    Ok(())
}

impl Store {
    pub fn booking_notices_after(
        &self,
        after: i64,
    ) -> Result<Vec<(i64, CalendarNoticeKind, Appointment)>> {
        let mut query = self.conn.prepare(
            "SELECT n.id, n.kind, a.json FROM booking_notice n
             JOIN appointment a ON a.id = n.appointment_id
             WHERE n.id > ?1
               AND a.status = CASE WHEN n.kind = 'cancelled' THEN 'cancelled' ELSE 'booked' END
             ORDER BY n.id DESC LIMIT 3",
        )?;
        let rows = query.query_map([after], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        rows.map(|row| {
            let (id, kind, json) = row?;
            Ok((
                id,
                CalendarNoticeKind::parse(&kind)?,
                serde_json::from_str(&json)?,
            ))
        })
        .collect()
    }
}
