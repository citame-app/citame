//! Local SQLite replica: mirror of the synced entities, the outbox, the cursor and conflicts.
//!
//! The mirror holds server state only. Local, not yet acknowledged edits live in the outbox and
//! are layered on top at read time (see `calendar`), so a pull can never clobber a pending edit
//! and a rejection never leaves a phantom row behind.

use std::path::Path;

use chrono::{SecondsFormat, Utc};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::error::{CoreError, Result};
use crate::model::*;

const MIGRATIONS: &[&str] = &[
    // 1: initial schema
    r#"
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

    CREATE TABLE client (id TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE service (id TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE staff (id TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE service_staff (id TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE working_hours (id TEXT PRIMARY KEY, staff_id TEXT NOT NULL, json TEXT NOT NULL);
    CREATE TABLE time_off (
        id TEXT PRIMARY KEY, staff_id TEXT NOT NULL,
        starts_at_ms INTEGER NOT NULL, ends_at_ms INTEGER NOT NULL, json TEXT NOT NULL);
    CREATE TABLE salon_settings (id TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE appointment (
        id TEXT PRIMARY KEY, staff_id TEXT NOT NULL,
        starts_at_ms INTEGER NOT NULL, ends_at_ms INTEGER NOT NULL,
        status TEXT NOT NULL, version INTEGER NOT NULL, json TEXT NOT NULL);
    CREATE INDEX appointment_range ON appointment (starts_at_ms, ends_at_ms);

    CREATE TABLE outbox (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        mutation_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        kind TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT);

    CREATE TABLE conflict (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        mutation_id TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        reason TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        resolution TEXT);
    CREATE INDEX conflict_open ON conflict (entity_id) WHERE resolved_at IS NULL;
    "#,
];

const MIRROR_TABLES: &[&str] = &[
    "client",
    "service",
    "staff",
    "service_staff",
    "working_hours",
    "time_off",
    "salon_settings",
    "appointment",
];

pub struct Store {
    conn: Connection,
}

/// What `apply_push_results` did.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct PushApplied {
    pub applied: usize,
    pub rejected: usize,
    /// True when a `retry` result stopped processing; the rest stays queued.
    pub retry_pending: bool,
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn parse<T: DeserializeOwned>(data: &Option<Value>, entity: &str, id: &str) -> Result<T> {
    let v = data
        .clone()
        .ok_or_else(|| CoreError::Protocol(format!("{entity} {id}: upsert without data")))?;
    serde_json::from_value(v)
        .map_err(|e| CoreError::Protocol(format!("{entity} {id}: unexpected shape: {e}")))
}

fn upsert_json(tx: &Transaction, table: &str, id: &str, json: &str) -> Result<()> {
    tx.execute(
        &format!(
            "INSERT INTO {table} (id, json) VALUES (?1, ?2)
             ON CONFLICT(id) DO UPDATE SET json = excluded.json"
        ),
        params![id, json],
    )?;
    Ok(())
}

fn apply_change(tx: &Transaction, c: &RawChange) -> Result<()> {
    const KNOWN: &[&str] = &[
        "appointment",
        "client",
        "service",
        "staff",
        "service_staff",
        "working_hours",
        "time_off",
        "salon_settings",
    ];
    if !KNOWN.contains(&c.entity.as_str()) {
        // Forward compatibility: a newer server may announce entities this build does not know.
        return Ok(());
    }
    match c.op.as_str() {
        "delete" => {
            tx.execute(&format!("DELETE FROM {} WHERE id = ?1", c.entity), params![c.id])?;
            Ok(())
        }
        "upsert" => upsert(tx, c),
        other => Err(CoreError::Protocol(format!("unknown op {other:?} at seq {}", c.seq))),
    }
}

fn upsert(tx: &Transaction, c: &RawChange) -> Result<()> {
    let id = c.id.as_str();
    match c.entity.as_str() {
        "appointment" => {
            let a: Appointment = parse(&c.data, "appointment", id)?;
            tx.execute(
                "INSERT INTO appointment (id, staff_id, starts_at_ms, ends_at_ms, status, version, json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(id) DO UPDATE SET staff_id = excluded.staff_id,
                   starts_at_ms = excluded.starts_at_ms, ends_at_ms = excluded.ends_at_ms,
                   status = excluded.status, version = excluded.version, json = excluded.json",
                params![
                    a.id,
                    a.staff_id,
                    a.starts_at.timestamp_millis(),
                    a.ends_at.timestamp_millis(),
                    a.status.as_str(),
                    a.version,
                    serde_json::to_string(&a)?
                ],
            )?;
        }
        "client" => {
            let v: Client = parse(&c.data, "client", id)?;
            upsert_json(tx, "client", id, &serde_json::to_string(&v)?)?;
        }
        "service" => {
            let v: Service = parse(&c.data, "service", id)?;
            upsert_json(tx, "service", id, &serde_json::to_string(&v)?)?;
        }
        "staff" => {
            let v: Staff = parse(&c.data, "staff", id)?;
            upsert_json(tx, "staff", id, &serde_json::to_string(&v)?)?;
        }
        "service_staff" => {
            let v: ServiceStaff = parse(&c.data, "service_staff", id)?;
            upsert_json(tx, "service_staff", id, &serde_json::to_string(&v)?)?;
        }
        "working_hours" => {
            let v: WorkingHours = parse(&c.data, "working_hours", id)?;
            tx.execute(
                "INSERT INTO working_hours (id, staff_id, json) VALUES (?1, ?2, ?3)
                 ON CONFLICT(id) DO UPDATE SET staff_id = excluded.staff_id, json = excluded.json",
                params![v.id, v.staff_id, serde_json::to_string(&v)?],
            )?;
        }
        "time_off" => {
            let v: TimeOff = parse(&c.data, "time_off", id)?;
            tx.execute(
                "INSERT INTO time_off (id, staff_id, starts_at_ms, ends_at_ms, json)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(id) DO UPDATE SET staff_id = excluded.staff_id,
                   starts_at_ms = excluded.starts_at_ms, ends_at_ms = excluded.ends_at_ms,
                   json = excluded.json",
                params![
                    v.id,
                    v.staff_id,
                    v.starts_at.timestamp_millis(),
                    v.ends_at.timestamp_millis(),
                    serde_json::to_string(&v)?
                ],
            )?;
        }
        "salon_settings" => {
            let v: SalonSettings = parse(&c.data, "salon_settings", id)?;
            upsert_json(tx, "salon_settings", "1", &serde_json::to_string(&v)?)?;
        }
        _ => unreachable!("filtered by KNOWN"),
    }
    Ok(())
}

fn outbox_from_row(r: &rusqlite::Row) -> rusqlite::Result<OutboxEntry> {
    let payload: String = r.get(5)?;
    Ok(OutboxEntry {
        seq: r.get(0)?,
        mutation_id: r.get(1)?,
        created_at: r.get(2)?,
        kind: r.get(3)?,
        entity_id: r.get(4)?,
        payload: serde_json::from_str(&payload).unwrap_or(Value::Null),
        attempts: r.get(6)?,
        last_error: r.get(7)?,
    })
}

const OUTBOX_COLS: &str =
    "seq, mutation_id, created_at, kind, entity_id, payload, attempts, last_error";

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
            std::fs::create_dir_all(dir)?;
        }
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        Self::init(conn)
    }

    pub fn open_in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(mut conn: Connection) -> Result<Self> {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        let current: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        for (i, sql) in MIGRATIONS.iter().enumerate().skip(current as usize) {
            let tx = conn.transaction()?;
            tx.execute_batch(sql)?;
            tx.pragma_update(None, "user_version", (i + 1) as i64)?;
            tx.commit()?;
        }
        Ok(Self { conn })
    }

    pub fn schema_version(&self) -> Result<i64> {
        Ok(self.conn.pragma_query_value(None, "user_version", |r| r.get(0))?)
    }

    pub fn get_meta(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row("SELECT value FROM meta WHERE key = ?1", params![key], |r| r.get(0))
            .optional()?)
    }

    pub fn set_meta(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    /// Stable per installation; generated on first use.
    pub fn device_id(&self) -> Result<String> {
        if let Some(id) = self.get_meta("device_id")? {
            return Ok(id);
        }
        let id = format!("desktop-{}", uuid::Uuid::now_v7());
        self.conn.execute(
            "INSERT INTO meta (key, value) VALUES ('device_id', ?1) ON CONFLICT(key) DO NOTHING",
            params![id],
        )?;
        Ok(self.get_meta("device_id")?.unwrap_or(id))
    }

    pub fn cursor(&self) -> Result<i64> {
        Ok(self.get_meta("cursor")?.and_then(|v| v.parse().ok()).unwrap_or(0))
    }

    /// Applies one pull page and moves the cursor in a single transaction. The cursor never
    /// decreases. Returns the number of changes applied.
    pub fn apply_page(&mut self, changes: &[RawChange], next_cursor: i64) -> Result<usize> {
        let tx = self.conn.transaction()?;
        for c in changes {
            apply_change(&tx, c)?;
        }
        tx.execute(
            "INSERT INTO meta (key, value) VALUES ('cursor', ?1)
             ON CONFLICT(key) DO UPDATE SET value = CAST(MAX(CAST(value AS INTEGER), CAST(?1 AS INTEGER)) AS TEXT)",
            params![next_cursor.to_string()],
        )?;
        tx.commit()?;
        Ok(changes.len())
    }

    /// Drops the mirror and the cursor (cursor ahead of the server, ADR 0007). The outbox, the
    /// open conflicts and the device id are kept: they are the user's work.
    pub fn reset_replica(&mut self) -> Result<()> {
        let tx = self.conn.transaction()?;
        for t in MIRROR_TABLES {
            tx.execute(&format!("DELETE FROM {t}"), [])?;
        }
        tx.execute("DELETE FROM meta WHERE key = 'cursor'", [])?;
        tx.commit()?;
        Ok(())
    }

    fn rows<T: DeserializeOwned>(&self, sql: &str) -> Result<Vec<T>> {
        let mut stmt = self.conn.prepare(sql)?;
        let raw = stmt.query_map([], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        raw.iter().map(|j| Ok(serde_json::from_str(j)?)).collect()
    }

    pub fn staff(&self) -> Result<Vec<Staff>> {
        let mut v: Vec<Staff> = self.rows("SELECT json FROM staff")?;
        v.retain(|s| s.active);
        v.sort_by(|a, b| a.display_name.to_lowercase().cmp(&b.display_name.to_lowercase()).then(a.id.cmp(&b.id)));
        Ok(v)
    }

    pub fn services(&self) -> Result<Vec<Service>> {
        let mut v: Vec<Service> = self.rows("SELECT json FROM service")?;
        v.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then(a.id.cmp(&b.id)));
        Ok(v)
    }

    pub fn clients(&self) -> Result<Vec<Client>> {
        let mut v: Vec<Client> = self.rows("SELECT json FROM client")?;
        v.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then(a.id.cmp(&b.id)));
        Ok(v)
    }

    pub fn working_hours(&self) -> Result<Vec<WorkingHours>> {
        self.rows("SELECT json FROM working_hours")
    }

    pub fn time_off_between(&self, from_ms: i64, to_ms: i64) -> Result<Vec<TimeOff>> {
        let mut stmt = self.conn.prepare(
            "SELECT json FROM time_off WHERE starts_at_ms < ?2 AND ends_at_ms > ?1 ORDER BY starts_at_ms",
        )?;
        let raw = stmt
            .query_map(params![from_ms, to_ms], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        raw.iter().map(|j| Ok(serde_json::from_str(j)?)).collect()
    }

    pub fn salon_settings(&self) -> Result<Option<SalonSettings>> {
        let j: Option<String> = self
            .conn
            .query_row("SELECT json FROM salon_settings LIMIT 1", [], |r| r.get(0))
            .optional()?;
        j.map(|j| Ok(serde_json::from_str(&j)?)).transpose()
    }

    pub fn appointment(&self, id: &str) -> Result<Option<Appointment>> {
        let j: Option<String> = self
            .conn
            .query_row("SELECT json FROM appointment WHERE id = ?1", params![id], |r| r.get(0))
            .optional()?;
        j.map(|j| Ok(serde_json::from_str(&j)?)).transpose()
    }

    /// Mirror appointments overlapping `[from_ms, to_ms)` (server state, no local edits).
    pub fn appointments_between(&self, from_ms: i64, to_ms: i64) -> Result<Vec<Appointment>> {
        let mut stmt = self.conn.prepare(
            "SELECT json FROM appointment WHERE starts_at_ms < ?2 AND ends_at_ms > ?1
             ORDER BY starts_at_ms, id",
        )?;
        let raw = stmt
            .query_map(params![from_ms, to_ms], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        raw.iter().map(|j| Ok(serde_json::from_str(j)?)).collect()
    }

    /// Queues a mutation. The id and `createdAt` are fixed here, at the moment the user acts,
    /// and reused verbatim on every resend.
    pub fn enqueue(&mut self, kind: &str, entity_id: &str, payload: Value) -> Result<OutboxEntry> {
        let mutation_id = uuid::Uuid::now_v7().to_string();
        let created_at = now_iso();
        self.conn.execute(
            "INSERT INTO outbox (mutation_id, created_at, kind, entity_id, payload)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![mutation_id, created_at, kind, entity_id, serde_json::to_string(&payload)?],
        )?;
        let seq = self.conn.last_insert_rowid();
        Ok(OutboxEntry {
            seq,
            mutation_id,
            created_at,
            kind: kind.to_owned(),
            entity_id: entity_id.to_owned(),
            payload,
            attempts: 0,
            last_error: None,
        })
    }

    pub fn outbox(&self, limit: usize) -> Result<Vec<OutboxEntry>> {
        let mut stmt = self
            .conn
            .prepare(&format!("SELECT {OUTBOX_COLS} FROM outbox ORDER BY seq LIMIT ?1"))?;
        Ok(stmt
            .query_map(params![limit as i64], outbox_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn outbox_len(&self) -> Result<usize> {
        Ok(self.conn.query_row("SELECT COUNT(*) FROM outbox", [], |r| r.get::<_, i64>(0))? as usize)
    }

    /// Records the server's verdicts for a batch, in order, in one transaction. `applied` and
    /// `rejected` leave the outbox (rejections become conflicts); the first `retry` and
    /// everything after it stay queued.
    pub fn apply_push_results(
        &mut self,
        sent: &[OutboxEntry],
        results: &[MutationResult],
    ) -> Result<PushApplied> {
        if results.len() != sent.len() {
            return Err(CoreError::Protocol(format!(
                "push returned {} results for {} mutations",
                results.len(),
                sent.len()
            )));
        }
        for (s, r) in sent.iter().zip(results) {
            if s.mutation_id != r.mutation_id() {
                return Err(CoreError::Protocol(format!(
                    "result for {} where {} was expected",
                    r.mutation_id(),
                    s.mutation_id
                )));
            }
        }
        let tx = self.conn.transaction()?;
        let mut out = PushApplied::default();
        for (s, r) in sent.iter().zip(results) {
            match r {
                MutationResult::Applied { .. } => {
                    tx.execute("DELETE FROM outbox WHERE mutation_id = ?1", params![s.mutation_id])?;
                    out.applied += 1;
                }
                MutationResult::Rejected { reason, message, .. } => {
                    tx.execute("DELETE FROM outbox WHERE mutation_id = ?1", params![s.mutation_id])?;
                    let open: i64 = tx.query_row(
                        "SELECT COUNT(*) FROM conflict WHERE entity_id = ?1 AND resolved_at IS NULL",
                        params![s.entity_id],
                        |r| r.get(0),
                    )?;
                    if open == 0 {
                        tx.execute(
                            "INSERT INTO conflict (mutation_id, kind, entity_id, payload, reason, message, created_at)
                             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                            params![
                                s.mutation_id,
                                s.kind,
                                s.entity_id,
                                serde_json::to_string(&s.payload)?,
                                reason,
                                message,
                                now_iso()
                            ],
                        )?;
                    }
                    out.rejected += 1;
                }
                MutationResult::Retry { message, .. } => {
                    tx.execute(
                        "UPDATE outbox SET attempts = attempts + 1, last_error = ?2 WHERE mutation_id = ?1",
                        params![s.mutation_id, message],
                    )?;
                    out.retry_pending = true;
                    break;
                }
            }
        }
        tx.commit()?;
        Ok(out)
    }

    pub fn record_failure(&mut self, mutation_ids: &[String], error: &str) -> Result<()> {
        let tx = self.conn.transaction()?;
        for id in mutation_ids {
            tx.execute(
                "UPDATE outbox SET attempts = attempts + 1, last_error = ?2 WHERE mutation_id = ?1",
                params![id, error],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Open (unresolved) conflicts, oldest first.
    pub fn conflicts(&self) -> Result<Vec<Conflict>> {
        let mut stmt = self.conn.prepare(
            "SELECT mutation_id, kind, entity_id, payload, reason, message, created_at
             FROM conflict WHERE resolved_at IS NULL ORDER BY seq",
        )?;
        Ok(stmt
            .query_map([], |r| {
                let payload: String = r.get(3)?;
                Ok(Conflict {
                    mutation_id: r.get(0)?,
                    kind: r.get(1)?,
                    entity_id: r.get(2)?,
                    payload: serde_json::from_str(&payload).unwrap_or(Value::Null),
                    reason: r.get(4)?,
                    message: r.get(5)?,
                    created_at: r.get(6)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn conflict(&self, mutation_id: &str) -> Result<Option<Conflict>> {
        Ok(self.conflicts()?.into_iter().find(|c| c.mutation_id == mutation_id))
    }

    pub fn resolve_conflict(&mut self, mutation_id: &str, resolution: &str) -> Result<()> {
        let n = self.conn.execute(
            "UPDATE conflict SET resolved_at = ?2, resolution = ?3
             WHERE mutation_id = ?1 AND resolved_at IS NULL",
            params![mutation_id, now_iso(), resolution],
        )?;
        if n == 0 {
            return Err(CoreError::NotFound(format!("open conflict {mutation_id}")));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
