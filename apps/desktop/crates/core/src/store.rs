//! Local SQLite replica: mirror of the synced entities, the outbox, the cursor and conflicts.
//!
//! The mirror holds server state only. Local, not yet acknowledged edits live in the outbox and
//! are layered on top at read time (see `calendar`), so a pull can never clobber a pending edit
//! and a rejection never leaves a phantom row behind.

use std::collections::HashSet;
use std::path::Path;

use chrono::{SecondsFormat, Utc};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::billing::SavedBankRefund;
use crate::error::{CoreError, Result};
use crate::http::{ReviewedSalonConfiguration, SalonConfigurationWrite};
use crate::model::*;
use crate::reports::commissions::SavedCommissionPayout;
use crate::sync::{CATALOG_COLORS_CACHED, CatalogColors};

mod calendar_notices;
pub mod gift_cache;
mod gift_purchase;
mod staff_portrait_draft;
mod visit_payment;
mod waitlist_cache;
pub use staff_portrait_draft::StaffPortraitDraft;
pub use waitlist_cache::{SavedWaitlistPages, WaitlistCacheScope};

fn pending_bank_refund_key(checkout_id: uuid::Uuid, actor_user_id: &str) -> String {
    format!("bank_refund_pending:{checkout_id}:{actor_user_id}")
}

fn pending_commission_payout_key(staff_id: uuid::Uuid, actor: &str) -> String {
    format!("commission_payout_pending:{staff_id}:{actor}")
}

pub(crate) const INITIAL_GENERATION: &str = "initial";
const GENERATION_KEY: &str = "sync_generation";
const REBUILD_KEY: &str = "sync_rebuilding";
const SALON_CONFIGURATION_CACHE: &str = "salon_configuration_cache";
const SALON_CONFIGURATION_ACK: &str = "salon_configuration_ack";
const SALON_CONFIGURATION_UNAVAILABLE: &str = "salon_configuration_unavailable";

#[derive(serde::Serialize, serde::Deserialize)]
struct SalonConfigurationAck {
    mutation_id: String,
    through: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SalonConfigurationWork {
    Idle,
    Pending(Option<SalonConfigurationWrite>),
    Conflict {
        id: String,
        write: SalonConfigurationWrite,
    },
}
const STAFF_DIRECTORY_TOPIC: &str = "staff_directory";
const SERVICE_CATALOG_TOPIC: &str = "service_catalog";

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
    // 2: date-specific schedule exceptions (existing replicas retain their outbox/cursor).
    r#"
    CREATE TABLE date_shift (id TEXT PRIMARY KEY, staff_id TEXT NOT NULL, date TEXT NOT NULL, json TEXT NOT NULL);
    CREATE INDEX date_shift_staff_date ON date_shift(staff_id,date);
    "#,
    // 3: bound native calendar notices and suppress echoes of acknowledged local bookings.
    r#"
    CREATE TABLE booking_notice (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        appointment_id TEXT NOT NULL UNIQUE REFERENCES appointment(id) ON DELETE CASCADE
    );
    CREATE TABLE local_booking_confirmation (
        appointment_id TEXT PRIMARY KEY,
        applied_seq INTEGER
    );
    "#,
    r#"
    CREATE INDEX appointment_client_history
        ON appointment (json_extract(json, '$.clientId'), starts_at_ms DESC, id);
    "#,
    // 5: submitted combination payloads stay immutable across retries and restarts.
    "ALTER TABLE outbox ADD COLUMN submitted INTEGER NOT NULL DEFAULT 0;",
    // 6: refresh legacy billing holds from the current projection without clearing the mirror.
    r#"
    UPDATE meta SET value = '0' WHERE key = 'cursor'
      AND EXISTS (
        SELECT 1 FROM appointment, json_each(appointment.json, '$.billingReviewReasons') AS reason
        WHERE json_extract(appointment.json, '$.importedFromBooksy') = 1
          AND reason.value = 'unknown_amount'
      );
    "#,
    // 7: detect older client projections without scanning the directory on every sync.
    r#"
    CREATE INDEX client_missing_group_names ON client(id)
      WHERE json_type(json, '$.groupNames') IS NULL;
    "#,
    r#"
    CREATE INDEX appointment_visit_group
        ON appointment (json_extract(json, '$.visitGroupId'), starts_at_ms, id)
        WHERE json_extract(json, '$.visitGroupId') IS NOT NULL;
    "#,
    r#"
    CREATE INDEX appointment_itinerary
        ON appointment (json_extract(json, '$.itineraryId'), starts_at_ms, id)
        WHERE json_extract(json, '$.itineraryId') IS NOT NULL;
    "#,
    r#"
    ALTER TABLE booking_notice ADD COLUMN kind TEXT NOT NULL DEFAULT 'new'
        CHECK (kind IN ('new', 'rescheduled', 'cancelled'));
    CREATE TABLE local_calendar_ack (
        seq INTEGER PRIMARY KEY,
        appointment_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        status TEXT NOT NULL,
        staff_id TEXT,
        starts_at_ms INTEGER
    );
    CREATE INDEX local_calendar_ack_version ON local_calendar_ack(appointment_id,version);
    "#,
    // Existing binaries can consume the server backfill before saving this projection.
    // Fill this projection separately from calendar notices and the main cursor.
    r#"
    INSERT INTO meta (key, value)
    SELECT 'booked_resources_cursor', '0' WHERE EXISTS (SELECT 1 FROM appointment);
    "#,
    // Replicas that already synced allocations by name must fetch their stable IDs.
    r#"
    INSERT INTO meta (key, value)
    SELECT 'booked_resources_cursor', '0' WHERE EXISTS (
        SELECT 1 FROM appointment, json_each(appointment.json, '$.resources') AS resource
         WHERE json_type(resource.value, '$.resourceId') IS NULL
    )
    ON CONFLICT(key) DO UPDATE SET value = '0';
    "#,
    r#"
    INSERT INTO meta (key,value)
    SELECT 'appointment_deposit_cursor','0' WHERE EXISTS (SELECT 1 FROM appointment)
    ON CONFLICT(key) DO NOTHING;
    "#,
];

const MIRROR_TABLES: &[&str] = &[
    "client",
    "service",
    "staff",
    "service_staff",
    "working_hours",
    "date_shift",
    "time_off",
    "salon_settings",
    "appointment",
];

pub struct Store {
    conn: Connection,
    reviewed_generation: String,
    validated_pool_catalogue: bool,
    validated_combination_catalogue: bool,
}

#[derive(Default)]
struct PullMetadata<'a> {
    refresh: &'a [String],
    generation: Option<&'a str>,
    catalogue_access: Option<bool>,
    calendar_edit_access: Option<bool>,
    time_off_scope: Option<&'a str>,
    resource_pools: Option<&'a [crate::resource_pools::ManagedPool]>,
    combinations: Option<&'a [crate::combinations::ManagedCombination]>,
    booking_combinations: Option<&'a [crate::combinations::ManagedCombination]>,
    booking_combination_access: Option<bool>,
    booked_combination_terms: Option<&'a [crate::combinations::BookedCombinationTerms]>,
    peak_prices: Option<&'a crate::booking::PeakPriceSnapshot>,
    peak_price_access: Option<bool>,
    inventory_access: Option<bool>,
    inventory_read_access: Option<bool>,
    portfolio_uploads: bool,
    gift_cards_scope: Option<&'a str>,
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

fn apply_change(tx: &Transaction, c: &RawChange, alert: bool) -> Result<()> {
    const KNOWN: &[&str] = &[
        "appointment",
        "client",
        "service",
        "staff",
        "service_staff",
        "working_hours",
        "date_shift",
        "time_off",
        "salon_settings",
    ];
    if !KNOWN.contains(&c.entity.as_str()) {
        // Forward compatibility: a newer server may announce entities this build does not know.
        return Ok(());
    }
    match c.op.as_str() {
        "delete" => {
            if c.entity == "salon_settings" {
                Store::remove_salon_configuration(tx)?;
            }
            tx.execute(
                &format!("DELETE FROM {} WHERE id = ?1", c.entity),
                params![c.id],
            )?;
            Ok(())
        }
        "upsert" => upsert(tx, c, alert),
        other => Err(CoreError::Protocol(format!(
            "unknown op {other:?} at seq {}",
            c.seq
        ))),
    }
}

fn upsert(tx: &Transaction, c: &RawChange, alert: bool) -> Result<()> {
    let id = c.id.as_str();
    match c.entity.as_str() {
        "appointment" => {
            let a: Appointment = parse(&c.data, "appointment", id)?;
            let notice = if alert {
                calendar_notices::classify(tx, &a)?
            } else {
                None
            };
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
            if a.resources
                .iter()
                .any(|resource| resource.resource_id.is_none())
            {
                // A fresh replica can see name-only allocations before its API is upgraded.
                tx.execute(
                    "INSERT INTO meta (key, value) VALUES ('booked_resources_cursor', '0')
                     ON CONFLICT(key) DO NOTHING",
                    [],
                )?;
            }
            if c.data
                .as_ref()
                .and_then(|data| data.get("depositStatus"))
                .is_none()
            {
                tx.execute(
                    "INSERT INTO meta (key, value) VALUES ('appointment_deposit_cursor', '0')
                     ON CONFLICT(key) DO NOTHING",
                    [],
                )?;
            }
            calendar_notices::apply(tx, &a.id, notice)?;
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
        "date_shift" => {
            let value: DateShift = parse(&c.data, "date_shift", id)?;
            tx.execute("INSERT INTO date_shift (id,staff_id,date,json) VALUES (?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET staff_id=excluded.staff_id,date=excluded.date,json=excluded.json",params![value.id,value.staff_id,value.date,serde_json::to_string(&value)?])?;
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
            if let Some(data) = c
                .data
                .as_ref()
                .and_then(|value| value.get("ownerConfiguration"))
            {
                if data.is_null() {
                    return Store::remove_salon_configuration(tx);
                }
                let mut settings = data.as_object().cloned().ok_or_else(|| {
                    CoreError::Protocol("Expected an owner settings snapshot".into())
                })?;
                let generation = Store::generation_at(tx)?;
                settings.insert("generation".into(), Value::String(generation));
                let reviewed = serde_json::from_value(Value::Object(settings))?;
                tx.execute(
                    "DELETE FROM meta WHERE key = ?1",
                    [SALON_CONFIGURATION_UNAVAILABLE],
                )?;
                Store::cache_salon_configuration_at(tx, &reviewed)?;
            }
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

fn inbox_key(archived: bool) -> &'static str {
    if archived {
        "calendar_inbox_archived"
    } else {
        "calendar_inbox_active"
    }
}

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
        conn.pragma_update(None, "foreign_keys", true)?;
        let current: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        for (i, sql) in MIGRATIONS.iter().enumerate().skip(current as usize) {
            let tx = conn.transaction()?;
            tx.execute_batch(sql)?;
            tx.pragma_update(None, "user_version", (i + 1) as i64)?;
            tx.commit()?;
        }
        let reviewed_generation = Self::generation_at(&conn)?;
        Ok(Self {
            conn,
            reviewed_generation,
            validated_pool_catalogue: false,
            validated_combination_catalogue: false,
        })
    }

    pub fn schema_version(&self) -> Result<i64> {
        Ok(self
            .conn
            .pragma_query_value(None, "user_version", |r| r.get(0))?)
    }

    pub fn peak_price_snapshot(&self) -> Result<Option<crate::booking::PeakPriceSnapshot>> {
        self.get_meta("peak_price_snapshot")?
            .map(|raw| serde_json::from_str(&raw).map_err(CoreError::from))
            .transpose()
    }

    pub fn calendar_edits_allowed(&self) -> Result<bool> {
        if let Some(value) = self.get_meta("viewer_edit_calendar")? {
            return Ok(value == "1");
        }
        // Older pulls identify restricted personal calendars through their time-off scope.
        let calendar_scope = self.get_meta("calendar_scope")?;
        Ok(calendar_scope.as_deref() == Some("all")
            || self.get_meta("time_off_scope")?.as_deref() != Some("none"))
    }

    pub fn get_meta(&self, key: &str) -> Result<Option<String>> {
        Self::meta_at(&self.conn, key)
    }

    fn meta_at(conn: &Connection, key: &str) -> Result<Option<String>> {
        Ok(conn
            .query_row("SELECT value FROM meta WHERE key = ?1", params![key], |r| {
                r.get(0)
            })
            .optional()?)
    }

    fn generation_at(conn: &Connection) -> Result<String> {
        Ok(Self::meta_at(conn, GENERATION_KEY)?.unwrap_or_else(|| INITIAL_GENERATION.into()))
    }

    pub(crate) fn replica_generation(&self) -> Result<String> {
        Self::generation_at(&self.conn)
    }

    /// Call before rendering an agenda snapshot. Edits from a stale view remain fenced.
    pub fn refresh_reviewed_generation(&mut self) -> Result<String> {
        self.reviewed_generation = self.replica_generation()?;
        Ok(self.reviewed_generation.clone())
    }

    pub fn verified_reviewed_generation(&self) -> Result<String> {
        let current = self.replica_generation()?;
        if current != self.reviewed_generation || self.get_meta(REBUILD_KEY)?.is_some() {
            return Err(CoreError::CalendarGenerationChanged);
        }
        Ok(current)
    }

    pub(crate) fn has_pending_client_creation(&self, id: &str) -> Result<bool> {
        Ok(self.conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM outbox WHERE kind = 'client.create' AND entity_id = ?1)",
            [id],
            |row| row.get(0),
        )?)
    }

    pub(crate) fn mark_local_booking_dispatch(&mut self, id: &str, generation: &str) -> Result<()> {
        self.mark_local_bookings_dispatch(std::iter::once(id), generation)
    }

    pub(crate) fn mark_local_bookings_dispatch<'a>(
        &mut self,
        ids: impl IntoIterator<Item = &'a str>,
        generation: &str,
    ) -> Result<()> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        for id in ids {
            let recorded = tx.execute(
                "INSERT INTO local_booking_confirmation (appointment_id, applied_seq)
             SELECT ?1, ?2 WHERE coalesce((SELECT value FROM meta WHERE key = ?3), ?4) = ?5
               AND NOT EXISTS (SELECT 1 FROM meta WHERE key = ?6)
             ON CONFLICT(appointment_id) DO UPDATE SET applied_seq = excluded.applied_seq",
                params![
                    id,
                    i64::MAX,
                    GENERATION_KEY,
                    INITIAL_GENERATION,
                    generation,
                    REBUILD_KEY
                ],
            )?;
            if recorded == 0 {
                return Err(CoreError::CalendarGenerationChanged);
            }
        }
        tx.execute(
            "DELETE FROM local_booking_confirmation WHERE appointment_id IN (
                SELECT appointment_id FROM local_booking_confirmation WHERE applied_seq = ?1
                ORDER BY appointment_id DESC LIMIT -1 OFFSET 256)",
            [i64::MAX],
        )?;
        tx.commit()?;
        Ok(())
    }

    fn ensure_generation(conn: &Connection, expected: Option<&str>) -> Result<()> {
        if let Some(expected) = expected
            && Self::generation_at(conn)? != expected
        {
            return Err(CoreError::Protocol(
                "Replica generation changed during sync".into(),
            ));
        }
        Ok(())
    }

    pub fn set_meta(&self, key: &str, value: &str) -> Result<()> {
        Self::set_meta_at(&self.conn, key, value)
    }

    pub fn cache_salon_configuration(
        &mut self,
        settings: &ReviewedSalonConfiguration,
    ) -> Result<()> {
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
        Self::ensure_generation(&tx, Some(&settings.generation))?;
        if Self::meta_at(&tx, SALON_CONFIGURATION_UNAVAILABLE)?.is_some() {
            return Err(CoreError::Invalid(
                "The latest replica removed the settings snapshot".into(),
            ));
        }
        let applied = Self::cache_salon_configuration_at(&tx, settings)?;
        tx.commit()?;
        if !applied {
            return Err(CoreError::Invalid(
                "Settings response is older than the cached review".into(),
            ));
        }
        Ok(())
    }

    fn cache_salon_configuration_at(
        conn: &Connection,
        settings: &ReviewedSalonConfiguration,
    ) -> Result<bool> {
        let cached = Self::meta_at(conn, SALON_CONFIGURATION_CACHE)?
            .map(|raw| serde_json::from_str::<ReviewedSalonConfiguration>(&raw))
            .transpose()?;
        if let Some(cached) = cached
            && cached.generation == settings.generation
            && cached.revision > settings.revision
        {
            return Ok(false);
        }
        Self::set_meta_at(
            conn,
            SALON_CONFIGURATION_CACHE,
            &serde_json::to_string(settings)?,
        )?;
        Ok(true)
    }

    pub fn cached_salon_configuration(&self) -> Result<Option<ReviewedSalonConfiguration>> {
        let Some(raw) = self.get_meta(SALON_CONFIGURATION_CACHE)? else {
            return Ok(None);
        };
        let saved: ReviewedSalonConfiguration = serde_json::from_str(&raw)?;
        Ok((saved.generation == self.replica_generation()?).then_some(saved))
    }

    fn remove_salon_configuration(conn: &Connection) -> Result<()> {
        conn.execute(
            "DELETE FROM meta WHERE key = ?1",
            [SALON_CONFIGURATION_CACHE],
        )?;
        Self::set_meta_at(conn, SALON_CONFIGURATION_UNAVAILABLE, "1")
    }

    fn salon_configuration_ack(conn: &Connection) -> Result<Option<SalonConfigurationAck>> {
        Self::meta_at(conn, SALON_CONFIGURATION_ACK)?
            .map(|value| Ok(serde_json::from_str(&value)?))
            .transpose()
    }

    pub fn salon_configuration_work(&self) -> Result<SalonConfigurationWork> {
        let pending: Option<String> = self
            .conn
            .query_row(
                "SELECT payload FROM outbox WHERE kind = 'settings.update' ORDER BY seq LIMIT 1",
                [],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(payload) = pending {
            return Ok(SalonConfigurationWork::Pending(
                serde_json::from_str(&payload).ok(),
            ));
        }
        let mut stmt = self.conn.prepare(
            "SELECT mutation_id,payload FROM conflict WHERE kind = 'settings.update' AND resolved_at IS NULL ORDER BY seq",
        )?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let payload: String = row.get(1)?;
            if let Ok(write) = serde_json::from_str(&payload) {
                return Ok(SalonConfigurationWork::Conflict {
                    id: row.get(0)?,
                    write,
                });
            }
        }
        Ok(SalonConfigurationWork::Idle)
    }

    pub fn queue_salon_configuration(
        &mut self,
        reviewed: &ReviewedSalonConfiguration,
        draft: &crate::http::SalonConfiguration,
        replacing: Option<&str>,
    ) -> Result<bool> {
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
        if self.verified_reviewed_generation()? != reviewed.generation {
            return Err(CoreError::CalendarGenerationChanged);
        }
        if Self::meta_at(&tx, SALON_CONFIGURATION_UNAVAILABLE)?.is_some() {
            return Err(CoreError::Invalid(
                "The latest replica removed the settings snapshot".into(),
            ));
        }
        let allowed = match self.salon_configuration_work()? {
            SalonConfigurationWork::Idle => replacing.is_none(),
            SalonConfigurationWork::Conflict { id, .. } => replacing == Some(id.as_str()),
            SalonConfigurationWork::Pending(_) => false,
        };
        if !allowed {
            return Err(CoreError::Invalid(
                "Another settings edit needs attention".into(),
            ));
        }
        let write = SalonConfigurationWrite::new(reviewed, draft);
        if let Some(write) = &write {
            self.enqueue_with_timestamp(
                "settings.update",
                "1",
                serde_json::to_value(write)?,
                now_iso(),
            )?;
        }
        if let Some(id) = replacing {
            Self::resolve_conflict_at(
                &tx,
                id,
                if write.is_some() {
                    "resubmitted"
                } else {
                    "reviewed"
                },
            )?;
        }
        tx.commit()?;
        Ok(write.is_some())
    }

    pub fn pending_stock(
        &self,
        id: crate::inventory::ProductId,
    ) -> Result<Option<crate::inventory::PendingStock>> {
        let Some(value) = self.get_meta(&format!("inventory_pending:{id}"))? else {
            return Ok(None);
        };
        let pending: crate::inventory::PendingStock = serde_json::from_str(&value)?;
        if pending.product_id != id {
            return Err(CoreError::Protocol(
                "Pending stock product identity mismatch".into(),
            ));
        }
        Ok(Some(pending))
    }

    /// A second instance must retry the original command, even if its product view is newer.
    pub fn reserve_pending_stock(&self, pending: &crate::inventory::PendingStock) -> Result<bool> {
        Ok(self.conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO NOTHING",
            params![
                format!("inventory_pending:{}", pending.product_id),
                serde_json::to_string(pending)?
            ],
        )? == 1)
    }

    /// A delayed result cannot remove a different command reserved by another instance.
    pub fn clear_pending_stock(&self, pending: &crate::inventory::PendingStock) -> Result<bool> {
        Ok(self.conn.execute(
            "DELETE FROM meta WHERE key = ?1 AND value = ?2",
            params![
                format!("inventory_pending:{}", pending.product_id),
                serde_json::to_string(pending)?
            ],
        )? == 1)
    }

    pub fn pending_stock_return(
        &self,
        receipt_id: uuid::Uuid,
        actor_user_id: &str,
    ) -> Result<Option<crate::inventory::StockReturnAttempt>> {
        let key = format!("inventory_pending_return:{receipt_id}:{actor_user_id}");
        self.get_meta(&key)?
            .map(|value| {
                let attempt: crate::inventory::StockReturnAttempt = serde_json::from_str(&value)?;
                if attempt.receipt_id != receipt_id
                    || attempt.command.actor_user_id != actor_user_id
                {
                    return Err(CoreError::Protocol(
                        "Pending stock return identity mismatch".into(),
                    ));
                }
                Ok(attempt)
            })
            .transpose()
    }

    pub fn pending_bank_refund(
        &self,
        checkout_id: uuid::Uuid,
        actor_user_id: &str,
    ) -> Result<Option<SavedBankRefund>> {
        self.get_meta(&pending_bank_refund_key(checkout_id, actor_user_id))?
            .map(|value| {
                let saved: SavedBankRefund = serde_json::from_str(&value)?;
                if saved.request.review.checkout_id != checkout_id
                    || saved.request.review.actor_user_id != actor_user_id
                {
                    return Err(CoreError::Protocol(
                        "Pending bank refund identity mismatch".into(),
                    ));
                }
                Ok(saved)
            })
            .transpose()
    }

    pub fn pending_commission_payout(
        &self,
        staff_id: uuid::Uuid,
        actor: &str,
    ) -> Result<Option<SavedCommissionPayout>> {
        self.get_meta(&pending_commission_payout_key(staff_id, actor))?
            .map(|value| {
                let saved: SavedCommissionPayout = serde_json::from_str(&value)?;
                if saved.staff_id != staff_id || saved.review.actor_user_id != actor {
                    return Err(CoreError::Protocol(
                        "Pending commission payout identity mismatch".into(),
                    ));
                }
                Ok(saved)
            })
            .transpose()
    }

    pub fn reserve_commission_payout(&self, saved: &SavedCommissionPayout) -> Result<bool> {
        let key = pending_commission_payout_key(saved.staff_id, &saved.review.actor_user_id);
        Ok(self.conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO NOTHING",
            params![key, serde_json::to_string(saved)?],
        )? == 1)
    }

    pub fn clear_commission_payout(&self, saved: &SavedCommissionPayout) -> Result<()> {
        let key = pending_commission_payout_key(saved.staff_id, &saved.review.actor_user_id);
        self.conn.execute(
            "DELETE FROM meta WHERE key = ?1 AND value = ?2",
            params![key, serde_json::to_string(saved)?],
        )?;
        Ok(())
    }

    pub fn rebind_commission_payout(
        &self,
        saved: &SavedCommissionPayout,
        generation: &str,
    ) -> Result<Option<SavedCommissionPayout>> {
        let key = pending_commission_payout_key(saved.staff_id, &saved.review.actor_user_id);
        let mut reviewed = saved.clone();
        reviewed.review.generation = generation.to_owned();
        let replaced = self.conn.execute(
            "UPDATE meta SET value = ?3 WHERE key = ?1 AND value = ?2",
            params![
                key,
                serde_json::to_string(saved)?,
                serde_json::to_string(&reviewed)?
            ],
        )? == 1;
        Ok(replaced.then_some(reviewed))
    }

    pub fn reserve_bank_refund(&self, saved: &SavedBankRefund) -> Result<bool> {
        let review = &saved.request.review;
        let key = pending_bank_refund_key(review.checkout_id, &review.actor_user_id);
        Ok(self.conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO NOTHING",
            params![key, serde_json::to_string(saved)?],
        )? == 1)
    }

    pub fn clear_bank_refund(&self, saved: &SavedBankRefund) -> Result<()> {
        let review = &saved.request.review;
        let key = pending_bank_refund_key(review.checkout_id, &review.actor_user_id);
        self.conn.execute(
            "DELETE FROM meta WHERE key = ?1 AND value = ?2",
            params![key, serde_json::to_string(saved)?],
        )?;
        Ok(())
    }

    pub fn settle_bank_refund(
        &self,
        saved: &SavedBankRefund,
        result: &std::result::Result<
            crate::billing::AppointmentCheckout,
            crate::sync::TransportError,
        >,
    ) -> Result<()> {
        // The transport reports failures after a successful POST as unverified outcomes.
        // Keep the key until the refreshed receipt is confirmed or the POST definitively failed.
        if matches!(
            result,
            Ok(_) | Err(crate::sync::TransportError::BadRequest(_))
        ) {
            self.clear_bank_refund(saved)?;
        }
        Ok(())
    }

    pub fn reserve_stock_return(
        &self,
        attempt: &crate::inventory::StockReturnAttempt,
    ) -> Result<bool> {
        let key = format!(
            "inventory_pending_return:{}:{}",
            attempt.receipt_id, attempt.command.actor_user_id
        );
        Ok(self.conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO NOTHING",
            params![key, serde_json::to_string(attempt)?],
        )? == 1)
    }

    pub fn clear_stock_return(&self, attempt: &crate::inventory::StockReturnAttempt) -> Result<()> {
        let key = format!(
            "inventory_pending_return:{}:{}",
            attempt.receipt_id, attempt.command.actor_user_id
        );
        self.conn.execute(
            "DELETE FROM meta WHERE key = ?1 AND value = ?2",
            params![key, serde_json::to_string(attempt)?],
        )?;
        Ok(())
    }

    pub fn settle_stock_return(
        &self,
        attempt: &crate::inventory::StockReturnAttempt,
        result: &std::result::Result<crate::inventory::Product, crate::sync::TransportError>,
    ) -> Result<()> {
        if matches!(
            result,
            Ok(_) | Err(crate::sync::TransportError::BadRequest(_))
        ) {
            self.clear_stock_return(attempt)?;
        }
        Ok(())
    }

    pub(crate) fn set_meta_in(&mut self, key: &str, value: &str, generation: &str) -> Result<()> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        Self::ensure_generation(&tx, Some(generation))?;
        Self::set_meta_at(&tx, key, value)?;
        tx.commit()?;
        Ok(())
    }

    fn set_meta_at(conn: &Connection, key: &str, value: &str) -> Result<()> {
        conn.execute(
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
        Ok(self
            .get_meta("cursor")?
            .and_then(|v| v.parse().ok())
            .unwrap_or(0))
    }

    pub(crate) fn booked_resources_cursor(&self) -> Result<Option<i64>> {
        Ok(self
            .get_meta("booked_resources_cursor")?
            .and_then(|value| value.parse().ok()))
    }

    pub(crate) fn apply_booked_resource_page(
        &mut self,
        changes: &[RawChange],
        next_cursor: i64,
        has_more: bool,
        generation: &str,
    ) -> Result<usize> {
        self.write_transaction(|store| {
            Self::ensure_generation(&store.conn, Some(generation))?;
            let mut updated = 0;
            for change in changes {
                if change.entity != "appointment" || change.op != "upsert" {
                    continue;
                }
                let Some(data) = &change.data else { continue };
                let Some(resources) = data.get("resources") else {
                    continue;
                };
                let Some(version) = data.get("version").and_then(Value::as_i64) else {
                    continue;
                };
                let resources: Vec<BookedResource> = serde_json::from_value(resources.clone())?;
                updated += store.conn.execute(
                    "UPDATE appointment SET json = json_set(json, '$.resources', json(?2))
                     WHERE id = ?1 AND version = ?3 AND (
                         json_type(json, '$.resources') IS NULL OR EXISTS (
                             SELECT 1 FROM json_each(appointment.json, '$.resources') AS resource
                             WHERE json_type(resource.value, '$.resourceId') IS NULL
                         )
                     )",
                    params![change.id, serde_json::to_string(&resources)?, version],
                )?;
            }
            if has_more {
                Self::set_meta_at(
                    &store.conn,
                    "booked_resources_cursor",
                    &next_cursor.to_string(),
                )?;
            } else {
                store
                    .conn
                    .execute("DELETE FROM meta WHERE key = 'booked_resources_cursor'", [])?;
            }
            Ok(updated)
        })
    }

    pub(crate) fn appointment_deposit_cursor(&self) -> Result<Option<i64>> {
        Ok(self
            .get_meta("appointment_deposit_cursor")?
            .and_then(|value| value.parse().ok()))
    }

    pub(crate) fn apply_appointment_deposit_page(
        &mut self,
        changes: &[RawChange],
        next_cursor: i64,
        has_more: bool,
        generation: &str,
    ) -> Result<usize> {
        self.write_transaction(|store| {
            Self::ensure_generation(&store.conn, Some(generation))?;
            let mut updated = 0;
            for change in changes {
                if change.entity != "appointment" || change.op != "upsert" {
                    continue;
                }
                let Some(data) = &change.data else { continue };
                let Some(version) = data.get("version").and_then(Value::as_i64) else {
                    continue;
                };
                let Some(status) = data.get("depositStatus") else {
                    continue;
                };
                let status: Option<AppointmentDepositStatus> =
                    serde_json::from_value(status.clone())?;
                updated += store.conn.execute(
                    "UPDATE appointment SET json = json_set(json, '$.depositStatus', json(?2))
                     WHERE id = ?1 AND version = ?3",
                    params![change.id, serde_json::to_string(&status)?, version],
                )?;
            }
            if has_more {
                Self::set_meta_at(
                    &store.conn,
                    "appointment_deposit_cursor",
                    &next_cursor.to_string(),
                )?;
            } else {
                store.conn.execute(
                    "DELETE FROM meta WHERE key = 'appointment_deposit_cursor'",
                    [],
                )?;
            }
            Ok(updated)
        })
    }

    /// Resume enrichment for legacy rows without rewinding the main change stream.
    pub(crate) fn client_groups_cursor(&self) -> Result<Option<i64>> {
        let missing: bool = self.conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM client WHERE json_type(json, '$.groupNames') IS NULL)",
            [],
            |row| row.get(0),
        )?;
        if !missing {
            return Ok(None);
        }
        let cursor = self
            .get_meta("client_groups_cursor")?
            .and_then(|value| value.parse().ok())
            .unwrap_or(0);
        Ok(Some(cursor))
    }

    pub(crate) fn apply_client_group_page(
        &mut self,
        changes: &[RawChange],
        next_cursor: i64,
        generation: &str,
    ) -> Result<usize> {
        self.write_transaction(|store| {
            Self::ensure_generation(&store.conn, Some(generation))?;
            let mut updated = 0;
            for change in changes {
                if change.entity != "client" || change.op != "upsert" {
                    continue;
                }
                let Some(groups) = change
                    .data
                    .as_ref()
                    .and_then(|data| data.get("groupNames"))
                    .filter(|groups| {
                        groups
                            .as_array()
                            .is_some_and(|groups| groups.iter().all(serde_json::Value::is_string))
                    })
                else {
                    continue;
                };
                updated += store.conn.execute(
                    "UPDATE client SET json = json_set(json, '$.groupNames', json(?2))
                     WHERE id = ?1 AND json_type(json, '$.groupNames') IS NULL",
                    params![change.id, groups.to_string()],
                )?;
            }
            store.conn.execute(
                "INSERT INTO meta (key,value) VALUES ('client_groups_cursor',?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [next_cursor],
            )?;
            Ok(updated)
        })
    }

    /// Changes when another connection commits to this replica.
    pub fn data_version(&self) -> Result<i64> {
        Ok(self
            .conn
            .pragma_query_value(None, "data_version", |r| r.get(0))?)
    }

    /// Latest applied invalidation for an online-only view. It shares the cursor transaction.
    pub fn staff_directory_revision(&self) -> Result<i64> {
        self.live_view_revision(STAFF_DIRECTORY_TOPIC)
    }

    pub fn catalog_revision(&self) -> Result<i64> {
        self.live_view_revision(SERVICE_CATALOG_TOPIC)
    }

    pub fn live_view_revision(&self, topic: &str) -> Result<i64> {
        Ok(self
            .get_meta(&format!("live_view:{topic}"))?
            .and_then(|value| value.parse().ok())
            .unwrap_or(0))
    }

    /// Keeps a compound local action invisible to the sync connection until both writes succeed.
    pub(crate) fn write_transaction<T>(
        &mut self,
        write: impl FnOnce(&mut Self) -> Result<T>,
    ) -> Result<T> {
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = write(self).and_then(|value| {
            self.conn.execute_batch("COMMIT")?;
            Ok(value)
        });
        if result.is_err() {
            self.conn.execute_batch("ROLLBACK")?;
        }
        result
    }

    /// Applies one pull page and moves the cursor in a single transaction. The cursor never
    /// decreases. Returns the number of changes applied.
    pub fn apply_page(&mut self, changes: &[RawChange], next_cursor: i64) -> Result<usize> {
        self.apply_replica_page(changes, next_cursor, false, false, PullMetadata::default())
    }

    /// Repairs the catalog projection even if an earlier release consumed its change log.
    pub(crate) fn apply_catalog_colors(
        &mut self,
        colors: &CatalogColors,
        generation: Option<&str>,
    ) -> Result<()> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        Self::ensure_generation(&tx, generation)?;
        tx.execute(
            "UPDATE service SET json = json_remove(json, '$.color') WHERE json_type(json, '$.color') = 'text'",
            [],
        )?;
        {
            let mut update = tx
                .prepare("UPDATE service SET json = json_set(json, '$.color', ?2) WHERE id = ?1")?;
            for (id, color) in colors {
                update.execute(params![id, color])?;
            }
        }
        tx.execute(
            "INSERT OR IGNORE INTO meta (key,value) VALUES (?1,'1')",
            [CATALOG_COLORS_CACHED],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub(crate) fn apply_pulled_page(
        &mut self,
        page: &PullResponse,
        alert: bool,
        generation: &str,
    ) -> Result<usize> {
        self.apply_replica_page(
            &page.changes,
            page.next_cursor,
            alert,
            !page.has_more,
            PullMetadata {
                refresh: &page.refresh,
                generation: Some(generation),
                catalogue_access: page.viewer_edit_catalogue,
                calendar_edit_access: page.viewer_edit_calendar,
                time_off_scope: page.time_off_scope.as_deref(),
                resource_pools: page.resource_pools.as_deref(),
                combinations: page.combinations.as_deref(),
                booking_combinations: page.booking_combinations.as_deref(),
                booking_combination_access: page.booking_combination_access,
                booked_combination_terms: page.booked_combination_terms.as_deref(),
                peak_prices: page.peak_prices.as_ref(),
                peak_price_access: page.peak_price_access,
                inventory_access: page.viewer_write_inventory,
                inventory_read_access: page.viewer_read_inventory.or(page.viewer_write_inventory),
                portfolio_uploads: page.portfolio_uploads.unwrap_or(false),
                gift_cards_scope: page.gift_cards_scope.as_deref(),
            },
        )
    }

    #[cfg(test)]
    pub(crate) fn apply_sync_page(
        &mut self,
        changes: &[RawChange],
        next_cursor: i64,
        alert: bool,
        complete: bool,
        refresh: &[String],
        generation: Option<&str>,
    ) -> Result<usize> {
        self.apply_replica_page(
            changes,
            next_cursor,
            alert,
            complete,
            PullMetadata {
                refresh,
                generation,
                ..Default::default()
            },
        )
    }

    fn apply_replica_page(
        &mut self,
        changes: &[RawChange],
        next_cursor: i64,
        alert: bool,
        complete: bool,
        metadata: PullMetadata<'_>,
    ) -> Result<usize> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        Self::ensure_generation(&tx, metadata.generation)?;
        if let Some(scope) = metadata.time_off_scope
            && Self::meta_at(&tx, "time_off_scope")?.as_deref() != Some(scope)
        {
            Self::set_meta_at(&tx, "time_off_scope", scope)?;
        }
        if let Some(allowed) = metadata.calendar_edit_access {
            let value = if allowed { "1" } else { "0" };
            if Self::meta_at(&tx, "viewer_edit_calendar")?.as_deref() != Some(value) {
                Self::set_meta_at(&tx, "viewer_edit_calendar", value)?;
            }
        }
        if let Some(allowed) = metadata.inventory_read_access {
            Self::apply_inventory_read_access_at(&tx, allowed)?;
        }
        if let Some(allowed) = metadata.inventory_access {
            Self::apply_inventory_access_at(&tx, allowed)?;
        }
        if metadata.generation.is_some() {
            Self::apply_portfolio_upload_support_at(&tx, metadata.portfolio_uploads)?;
            gift_cache::apply_scope_at(&tx, metadata.gift_cards_scope)?;
        }
        if metadata.peak_price_access == Some(false) {
            tx.execute("DELETE FROM meta WHERE key = 'peak_price_snapshot'", [])?;
        } else if let Some(prices) = metadata.peak_prices {
            prices.validate()?;
            Self::set_meta_at(&tx, "peak_price_snapshot", &serde_json::to_string(prices)?)?;
        }
        let mut received_pools = false;
        let mut received_combinations = false;
        if let Some(allowed) = metadata.catalogue_access {
            let generation = Self::generation_at(&tx)?;
            Self::apply_catalogue_access_at(&tx, &generation, allowed)?;
            if allowed && let Some(pools) = metadata.resource_pools {
                Self::cache_resource_pools_at(&tx, pools, &generation)?;
                received_pools = true;
            }
            if allowed && let Some(combinations) = metadata.combinations {
                Self::cache_combinations_at(&tx, combinations, &generation)?;
                received_combinations = true;
            }
        }
        if metadata.generation.is_some() {
            if metadata.booking_combination_access != Some(true) {
                Self::forget_booking_combinations_at(&tx)?;
            } else {
                if let Some(combinations) = metadata.booking_combinations {
                    Self::cache_booking_combinations_at(
                        &tx,
                        combinations,
                        &Self::generation_at(&tx)?,
                    )?;
                }
                if let Some(terms) = metadata.booked_combination_terms {
                    Self::backfill_booked_combination_terms(&tx, terms)?;
                }
            }
        }
        let cursor = tx
            .query_row(
                "SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'cursor'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .unwrap_or(0);
        let mut applied = 0;
        for c in changes.iter().filter(|change| change.seq > cursor) {
            apply_change(&tx, c, alert)?;
            if c.op == "delete"
                && matches!(c.entity.as_str(), "appointment" | "client" | "time_off")
            {
                // An older log entry can already carry the server's current tombstone.
                tx.execute(
                    "UPDATE meta SET value = '0' WHERE key IN (
                       SELECT 'assignment_ack:' || mutation_id FROM outbox
                       WHERE entity_id = ?1 AND kind GLOB (?2 || '.*'))",
                    params![c.id, c.entity],
                )?;
            }
            if c.entity == "appointment" {
                tx.execute(
                    "DELETE FROM local_booking_confirmation WHERE appointment_id=?1",
                    params![c.id],
                )?;
            }
            applied += 1;
        }
        tx.execute(
            "DELETE FROM local_booking_confirmation WHERE applied_seq <= ?1",
            params![next_cursor],
        )?;
        tx.execute(
            "DELETE FROM local_calendar_ack WHERE seq <= ?1",
            [next_cursor],
        )?;
        if alert {
            tx.execute("DELETE FROM booking_notice WHERE id NOT IN (SELECT id FROM booking_notice ORDER BY id DESC LIMIT 12)",[])?;
        }
        if let Some(ack) = Self::salon_configuration_ack(&tx)?
            && next_cursor >= ack.through
        {
            tx.execute(
                "DELETE FROM outbox WHERE mutation_id = ?1",
                [ack.mutation_id],
            )?;
            tx.execute("DELETE FROM meta WHERE key = ?1", [SALON_CONFIGURATION_ACK])?;
        }
        Self::retire_confirmed_outbox(&tx, next_cursor)?;
        if complete {
            tx.execute(
                "INSERT OR IGNORE INTO meta (key,value) VALUES ('calendar_snapshot_complete','1')",
                [],
            )?;
            tx.execute("DELETE FROM meta WHERE key = ?1", [REBUILD_KEY])?;
        }
        if next_cursor > cursor {
            let staff_changed = changes
                .iter()
                .any(|change| change.seq > cursor && change.entity == "staff");
            let catalogue_changed = changes.iter().any(|change| {
                change.seq > cursor && matches!(change.entity.as_str(), "service" | "service_staff")
            });
            let review_dependencies_changed = changes
                .iter()
                .any(|change| matches!(change.entity.as_str(), "appointment" | "client" | "staff"));
            for topic in metadata
                .refresh
                .iter()
                .map(String::as_str)
                .chain(review_dependencies_changed.then_some(crate::reviews::LIVE_TOPIC))
                .chain(staff_changed.then_some(STAFF_DIRECTORY_TOPIC))
                .chain(catalogue_changed.then_some(SERVICE_CATALOG_TOPIC))
            {
                if matches!(
                    topic,
                    "commerce"
                        | "waitlist"
                        | "inbox"
                        | STAFF_DIRECTORY_TOPIC
                        | SERVICE_CATALOG_TOPIC
                        | crate::reviews::LIVE_TOPIC
                        | crate::http::PORTFOLIO_LIVE_TOPIC
                        | crate::intake::FORM_LIVE_TOPIC
                        | crate::intake::RECORD_LIVE_TOPIC
                        | crate::booking_policy::LIVE_TOPIC
                        | crate::http::email_delivery::LIVE_TOPIC
                        | crate::http::marketing::LIVE_TOPIC
                        | crate::promotions::LIVE_TOPIC
                        | crate::loyalty::LIVE_TOPIC
                        | crate::http::whatsapp::LIVE_TOPIC
                        | crate::service_resources::LIVE_TOPIC
                ) {
                    tx.execute(
                        "INSERT INTO meta (key, value) VALUES (?1, ?2)
                         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                        params![format!("live_view:{topic}"), next_cursor.to_string()],
                    )?;
                }
            }
        }
        tx.execute(
            "INSERT INTO meta (key, value) VALUES ('cursor', ?1)
             ON CONFLICT(key) DO UPDATE SET value = CAST(MAX(CAST(value AS INTEGER), CAST(?1 AS INTEGER)) AS TEXT)",
            params![next_cursor.to_string()],
        )?;
        tx.commit()?;
        self.validated_pool_catalogue |= received_pools;
        self.validated_combination_catalogue |= received_combinations;
        Ok(applied)
    }

    /// Drops the mirror and the cursor (cursor ahead of the server, ADR 0007). The outbox, the
    /// open conflicts and the device id are kept: they are the user's work.
    pub fn reset_replica(&mut self) -> Result<()> {
        self.reset_replica_in(None)
    }

    pub(crate) fn reset_replica_in(&mut self, generation: Option<&str>) -> Result<()> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        Self::ensure_generation(&tx, generation)?;
        Self::clear_replica(&tx)?;
        tx.commit()?;
        Ok(())
    }

    /// Keep work from a different history for manual review, without ever replaying it there.
    pub(crate) fn switch_replica_generation(
        &mut self,
        expected: &str,
        generation: &str,
    ) -> Result<()> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        Self::ensure_generation(&tx, Some(expected))?;
        tx.execute(
            "UPDATE conflict SET reason = ?1 WHERE resolved_at IS NULL",
            [RESTORED_HISTORY],
        )?;
        tx.execute(
            "INSERT INTO conflict (mutation_id, kind, entity_id, payload, reason, message, created_at)
             SELECT mutation_id, kind, entity_id, payload, ?1,
                    'Review this change against the restored calendar', created_at
             FROM outbox ORDER BY seq ON CONFLICT(mutation_id) DO NOTHING",
            [RESTORED_HISTORY],
        )?;
        tx.execute("DELETE FROM outbox", [])?;
        tx.execute("DELETE FROM meta WHERE key GLOB 'assignment_ack:*'", [])?;
        tx.execute("DELETE FROM booking_notice", [])?;
        Self::clear_replica(&tx)?;
        tx.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2), (?3, '1')
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [GENERATION_KEY, generation, REBUILD_KEY],
        )?;
        tx.commit()?;
        self.reviewed_generation = generation.to_owned();
        Ok(())
    }

    fn clear_replica(tx: &Transaction) -> Result<()> {
        for t in MIRROR_TABLES {
            tx.execute(&format!("DELETE FROM {t}"), [])?;
        }
        tx.execute(
            "DELETE FROM meta WHERE key IN ('cursor','client_groups_cursor','booked_resources_cursor','appointment_deposit_cursor','calendar_snapshot_complete','calendar_inbox_archived','calendar_inbox_active','resource_pool_catalogue','peak_price_snapshot',?1,?2,?3,?4) OR key LIKE 'live_view:%' OR key LIKE 'reviewed_service_resources:%'",
            [CATALOG_COLORS_CACHED, SALON_CONFIGURATION_CACHE, SALON_CONFIGURATION_ACK, SALON_CONFIGURATION_UNAVAILABLE],
        )?;
        Self::forget_combinations_at(tx)?;
        Self::forget_booking_combinations_at(tx)?;
        Self::invalidate_resource_days(tx)?;
        tx.execute("DELETE FROM local_booking_confirmation", [])?;
        tx.execute("DELETE FROM local_calendar_ack", [])?;
        waitlist_cache::invalidate_visibility(tx)?;
        gift_cache::clear_at(tx)?;
        Self::apply_inventory_access_at(tx, false)?;
        Self::apply_inventory_read_access_at(tx, false)?;
        Ok(())
    }

    pub fn client_directory_enabled(&self) -> Result<bool> {
        Ok(self.get_meta("client_directory")?.as_deref() == Some("allowed"))
    }

    pub(crate) fn apply_visibility_scopes(
        &mut self,
        directory: Option<bool>,
        calendar: Option<&str>,
        generation: &str,
    ) -> Result<bool> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        Self::ensure_generation(&tx, Some(generation))?;
        let directory = directory.map(|allowed| if allowed { "allowed" } else { "denied" });
        let mut changes = Vec::new();
        for (key, scope) in [
            ("client_directory", directory),
            ("calendar_scope", calendar),
        ] {
            if let Some(scope) = scope
                && Self::meta_at(&tx, key)?.as_deref() != Some(scope)
            {
                changes.push((key, scope));
            }
        }
        if changes.is_empty() {
            return Ok(false);
        }
        let restart = Self::meta_at(&tx, "cursor")?.is_some_and(|cursor| cursor != "0");
        if restart {
            Self::clear_replica(&tx)?;
        } else {
            waitlist_cache::invalidate_visibility(&tx)?;
            if changes.iter().any(|(key, _)| *key == "calendar_scope") {
                Self::invalidate_resource_days(&tx)?;
                Self::forget_booking_combinations_at(&tx)?;
            }
        }
        for (key, scope) in changes {
            tx.execute(
                "INSERT INTO meta(key,value) VALUES(?1,?2)
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                [key, scope],
            )?;
        }
        tx.commit()?;
        Ok(restart)
    }

    pub fn resource_day(
        &self,
        date: chrono::NaiveDate,
    ) -> Result<Option<crate::resource_calendar::CachedResourceDay>> {
        if self.resource_denial_marker_present()? {
            return Ok(None);
        }
        self.read_snapshot(|store| {
            if store.get_meta("calendar_scope")?.as_deref() != Some("all")
                || store.get_meta(REBUILD_KEY)?.is_some()
                || store.get_meta("resource_day_denied")?.is_some()
            {
                return Ok(None);
            }
            store
                .get_meta(&format!("resource_day:{date}"))?
                .map(|raw| serde_json::from_str(&raw).map_err(CoreError::from))
                .transpose()
        })
    }

    fn resource_denial_marker(&self) -> Option<std::path::PathBuf> {
        self.conn
            .path()
            .filter(|path| !path.is_empty())
            .map(|path| std::path::Path::new(path).with_extension("resource-denied"))
    }

    fn resource_denial_marker_present(&self) -> Result<bool> {
        self.resource_denial_marker().map_or(Ok(false), |marker| {
            marker.try_exists().map_err(CoreError::from)
        })
    }

    pub(crate) fn recover_resource_denial(&mut self, generation: &str) -> Result<()> {
        if let Some(marker) = self.resource_denial_marker()
            && marker.try_exists()?
        {
            let tx = self
                .conn
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            Self::ensure_generation(&tx, Some(generation))?;
            Self::invalidate_resource_days(&tx)?;
            tx.commit()?;
            match std::fs::remove_file(marker) {
                Ok(()) => (),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }

    fn resource_day_revision_at(conn: &Connection) -> Result<i64> {
        Ok(Self::meta_at(conn, "resource_day_revision")?
            .and_then(|revision| revision.parse().ok())
            .unwrap_or(0))
    }

    pub fn resource_day_revision(&self) -> Result<i64> {
        Self::resource_day_revision_at(&self.conn)
    }

    pub fn cache_resource_day(
        &mut self,
        date: chrono::NaiveDate,
        generation: &str,
        revision: i64,
        snapshot: &crate::resource_calendar::CachedResourceDay,
        session: Option<&crate::auth::SessionHandle>,
    ) -> Result<bool> {
        let marker = self.resource_denial_marker();
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        Self::ensure_generation(&tx, Some(generation))?;
        if marker.map_or(Ok(false), |path| path.try_exists())?
            || Self::resource_day_revision_at(&tx)? != revision
            || Self::meta_at(&tx, "calendar_scope")?.as_deref() != Some("all")
            || Self::meta_at(&tx, REBUILD_KEY)?.is_some()
        {
            return Ok(false);
        }
        let key = format!("resource_day:{date}");
        if let Some(raw) = Self::meta_at(&tx, &key)?
            && let Ok(previous) =
                serde_json::from_str::<crate::resource_calendar::CachedResourceDay>(&raw)
            && previous
                .occupancy()
                .zip(snapshot.occupancy())
                .is_some_and(|(old, new)| old.captured_at > new.captured_at)
        {
            return Ok(false);
        }
        let raw = serde_json::to_string(snapshot)?;
        // Acquire this only after SQLite has granted the write lock. Sign-out and commit then
        // cannot cross, and the UI never waits for SQLite's busy timeout while signing out.
        let active = session.map(|handle| handle.read().expect("session lock"));
        if active.as_deref().is_some_and(Option::is_none) {
            return Ok(false);
        }
        Self::set_meta_at(&tx, &key, &raw)?;
        tx.execute("DELETE FROM meta WHERE key = 'resource_day_denied'", [])?;
        tx.execute(
            "DELETE FROM meta WHERE key LIKE 'resource_day:%' AND key IN (
                SELECT key FROM meta WHERE key LIKE 'resource_day:%'
                ORDER BY julianday(json_extract(value, '$.receivedAt')) DESC, key DESC LIMIT -1 OFFSET 14
            )",
            [],
        )?;
        tx.commit()?;
        drop(active);
        Ok(true)
    }

    fn invalidate_resource_days(tx: &Transaction) -> Result<()> {
        let revision = Self::resource_day_revision_at(tx)?.saturating_add(1);
        Self::set_meta_at(tx, "resource_day_revision", &revision.to_string())?;
        Self::set_meta_at(tx, "resource_day_denied", "1")?;
        tx.execute("DELETE FROM meta WHERE key LIKE 'resource_day:%'", [])?;
        Ok(())
    }

    pub(crate) fn deny_resource_days(
        &mut self,
        generation: &str,
        revision: i64,
        session: Option<&crate::auth::SessionHandle>,
    ) -> Result<bool> {
        let attempt = (|| {
            let tx = self
                .conn
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            Self::ensure_generation(&tx, Some(generation))?;
            if Self::resource_day_revision_at(&tx)? != revision {
                return Ok(false);
            }
            let active = session.map(|handle| handle.read().expect("session lock"));
            if active.as_deref().is_some_and(Option::is_none) {
                return Ok(false);
            }
            Self::invalidate_resource_days(&tx)?;
            tx.commit()?;
            drop(active);
            Ok(true)
        })();
        if matches!(&attempt, Err(CoreError::Db(_)))
            && let Some(marker) = self.resource_denial_marker()
        {
            // SQLite can be busy while the service has already rejected the request. The
            // account-private marker prevents offline reads until the denial can be recorded.
            let active = session.map(|handle| handle.read().expect("session lock"));
            if active.as_deref().is_some_and(Option::is_none)
                || self.replica_generation()? != generation
                || self.resource_day_revision()? != revision
            {
                return Ok(false);
            }
            let mut options = std::fs::OpenOptions::new();
            options.create(true).write(true).truncate(false);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            options.open(marker)?.sync_all()?;
            drop(active);
            return Ok(true);
        }
        attempt
    }

    pub fn booking_notice_head(&self) -> Result<i64> {
        Ok(self
            .conn
            .query_row("SELECT coalesce(max(id),0) FROM booking_notice", [], |r| {
                r.get(0)
            })?)
    }

    pub fn calendar_inbox_cache(&self, archived: bool) -> Result<Option<CalendarInbox>> {
        self.get_meta(inbox_key(archived))?
            .map(|raw| serde_json::from_str(&raw).map_err(CoreError::from))
            .transpose()
    }

    pub fn cache_calendar_inbox(&self, archived: bool, inbox: &CalendarInbox) -> Result<()> {
        self.set_meta(inbox_key(archived), &serde_json::to_string(inbox)?)
    }

    pub fn clear_calendar_inbox_cache(&self) -> Result<()> {
        self.conn.execute(
            "DELETE FROM meta WHERE key IN ('calendar_inbox_archived','calendar_inbox_active')",
            [],
        )?;
        Ok(())
    }

    fn rows<T: DeserializeOwned>(&self, sql: &str) -> Result<Vec<T>> {
        let mut stmt = self.conn.prepare(sql)?;
        let raw = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        raw.iter().map(|j| Ok(serde_json::from_str(j)?)).collect()
    }

    pub fn staff(&self) -> Result<Vec<Staff>> {
        let mut staff = self.staff_including_inactive()?;
        staff.retain(|member| member.active);
        Ok(staff)
    }

    pub fn staff_including_inactive(&self) -> Result<Vec<Staff>> {
        let mut v: Vec<Staff> = self.rows("SELECT json FROM staff")?;
        v.sort_by(|a, b| {
            a.display_name
                .to_lowercase()
                .cmp(&b.display_name.to_lowercase())
                .then(a.id.cmp(&b.id))
        });
        Ok(v)
    }

    pub fn services(&self) -> Result<Vec<Service>> {
        let mut v: Vec<Service> = self.rows("SELECT json FROM service")?;
        v.sort_by(|a, b| {
            a.name
                .to_lowercase()
                .cmp(&b.name.to_lowercase())
                .then(a.id.cmp(&b.id))
        });
        Ok(v)
    }

    pub fn client_is_synced(&self, id: &str) -> Result<bool> {
        Ok(self.conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM client WHERE id = ?1)",
            [id],
            |row| row.get(0),
        )?)
    }

    pub fn client_controls_revision(&self, id: &str) -> Result<Option<u64>> {
        Ok(self
            .conn
            .query_row(
                "SELECT json_extract(json, '$.controlsVersion') FROM client WHERE id = ?1",
                [id],
                |row| row.get::<_, Option<i64>>(0),
            )
            .optional()?
            .flatten()
            .and_then(|value| u64::try_from(value).ok()))
    }

    pub fn clients(&self) -> Result<Vec<Client>> {
        let mut v: Vec<Client> = self.rows("SELECT json FROM client")?;
        v.sort_by(|a, b| {
            a.name
                .to_lowercase()
                .cmp(&b.name.to_lowercase())
                .then(a.id.cmp(&b.id))
        });
        Ok(v)
    }

    pub fn service_staff(&self) -> Result<Vec<ServiceStaff>> {
        self.rows("SELECT json FROM service_staff")
    }

    pub fn working_hours(&self) -> Result<Vec<WorkingHours>> {
        self.rows("SELECT json FROM working_hours")
    }

    pub fn date_shifts(&self) -> Result<Vec<DateShift>> {
        self.rows("SELECT json FROM date_shift ORDER BY date,staff_id,id")
    }

    pub(crate) fn date_shifts_between(&self, from: &str, until: &str) -> Result<Vec<DateShift>> {
        let mut stmt = self.conn.prepare(
            "SELECT json FROM date_shift WHERE date >= ?1 AND date < ?2 ORDER BY date,staff_id,id",
        )?;
        let raw = stmt
            .query_map(params![from, until], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        raw.iter()
            .map(|json| Ok(serde_json::from_str(json)?))
            .collect()
    }

    pub(crate) fn read_snapshot<T>(&self, read: impl FnOnce(&Self) -> Result<T>) -> Result<T> {
        let snapshot = self.conn.unchecked_transaction()?;
        let value = read(self)?;
        snapshot.commit()?;
        Ok(value)
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

    pub fn time_off(&self, id: &str) -> Result<Option<TimeOff>> {
        let json: Option<String> = self
            .conn
            .query_row("SELECT json FROM time_off WHERE id = ?1", [id], |row| {
                row.get(0)
            })
            .optional()?;
        json.map(|json| Ok(serde_json::from_str(&json)?))
            .transpose()
    }

    /// Returns whether the replica has reached the head recorded on this rejection.
    pub(crate) fn time_off_review_ready(&self, mutation_id: &str) -> Result<Option<bool>> {
        let head = self.get_meta(&format!("time_off_review_head:{mutation_id}"))?;
        head.map(|value| {
            let expected: i64 = value.parse().map_err(|_| {
                CoreError::Protocol("Invalid time block conflict checkpoint".into())
            })?;
            Ok(self.cursor()? >= expected)
        })
        .transpose()
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
            .query_row(
                "SELECT json FROM appointment WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
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

    pub fn client_history(&self, id: &str) -> Result<Vec<Appointment>> {
        if !self.client_directory_enabled()? {
            return Ok(vec![]);
        }
        let mut stmt = self.conn.prepare(
            "SELECT json FROM appointment WHERE json_extract(json, '$.clientId') IN (
                SELECT ?1 UNION ALL
                SELECT id FROM client WHERE json_extract(json, '$.mergedIntoId') = ?1
             ) ORDER BY starts_at_ms DESC, id LIMIT 25",
        )?;
        let rows = stmt
            .query_map([id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.iter()
            .map(|row| Ok(serde_json::from_str(row)?))
            .collect()
    }

    pub(crate) fn appointments_in_visit_group(
        &self,
        group_id: &str,
        client_id: &str,
        native: bool,
    ) -> Result<Vec<Appointment>> {
        let field = if native {
            "$.itineraryId"
        } else {
            "$.visitGroupId"
        };
        let mut stmt = self.conn.prepare_cached(&format!(
            "SELECT json FROM appointment
             WHERE json_extract(json, '{field}') = ?1
               AND json_extract(json, '$.clientId') = ?2
             ORDER BY starts_at_ms, id",
        ))?;
        let rows = stmt
            .query_map([group_id, client_id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.iter()
            .map(|row| Ok(serde_json::from_str(row)?))
            .collect()
    }

    /// Queues a mutation. The id and `createdAt` are fixed here, at the moment the user acts,
    /// and reused verbatim on every resend.
    pub fn enqueue(&mut self, kind: &str, entity_id: &str, payload: Value) -> Result<OutboxEntry> {
        self.enqueue_with_timestamp(kind, entity_id, payload, now_iso())
    }

    /// Chained timestamp-checked changes must remain ordered even in the same millisecond.
    pub(crate) fn enqueue_after(
        &mut self,
        kind: &str,
        entity_id: &str,
        payload: Value,
        previous: chrono::DateTime<Utc>,
    ) -> Result<OutboxEntry> {
        let timestamp = Utc::now().max(previous + chrono::Duration::milliseconds(1));
        self.enqueue_with_timestamp(
            kind,
            entity_id,
            payload,
            timestamp.to_rfc3339_opts(SecondsFormat::Millis, true),
        )
    }

    fn enqueue_with_timestamp(
        &self,
        kind: &str,
        entity_id: &str,
        payload: Value,
        created_at: String,
    ) -> Result<OutboxEntry> {
        let mutation_id = uuid::Uuid::now_v7().to_string();
        let inserted = self.conn.execute(
            "INSERT INTO outbox (mutation_id, created_at, kind, entity_id, payload)
             SELECT ?1, ?2, ?3, ?4, ?5
             WHERE coalesce((SELECT value FROM meta WHERE key = ?6), ?7) = ?8
               AND NOT EXISTS (SELECT 1 FROM meta WHERE key = ?9)",
            params![
                mutation_id,
                created_at,
                kind,
                entity_id,
                serde_json::to_string(&payload)?,
                GENERATION_KEY,
                INITIAL_GENERATION,
                self.reviewed_generation,
                REBUILD_KEY,
            ],
        )?;
        if inserted == 0 {
            return Err(CoreError::Invalid(
                "Refresh the restored calendar before editing".into(),
            ));
        }
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

    pub fn appointment_edit_sync(&self, id: &str) -> Result<AppointmentEditSync> {
        let (pending, rejected): (bool, bool) = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM outbox WHERE entity_id = ?1 AND kind LIKE 'appointment.%'),
                    EXISTS(SELECT 1 FROM conflict WHERE entity_id = ?1 AND kind LIKE 'appointment.%'
                           AND resolved_at IS NULL)",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        Ok(if pending {
            AppointmentEditSync::Pending
        } else if rejected {
            AppointmentEditSync::NeedsResolution
        } else {
            AppointmentEditSync::Settled
        })
    }

    pub fn outbox(&self, limit: usize) -> Result<Vec<OutboxEntry>> {
        Self::outbox_at(&self.conn, limit, None, false)
    }

    // Keep confirmed local projections visible until the authoritative pull catches up.
    // The checkpoint key keeps its original name for existing replicas.
    fn retire_confirmed_outbox(tx: &Transaction, cursor: i64) -> Result<()> {
        tx.execute(
            "DELETE FROM outbox WHERE mutation_id IN (
               SELECT substr(key, length('assignment_ack:') + 1) FROM meta
               WHERE key GLOB 'assignment_ack:*' AND CAST(value AS INTEGER) <= ?1)",
            [cursor],
        )?;
        tx.execute(
            "DELETE FROM meta WHERE key GLOB 'assignment_ack:*' AND CAST(value AS INTEGER) <= ?1",
            [cursor],
        )?;
        tx.execute(
            "DELETE FROM meta WHERE key GLOB 'time_off_review_head:*'
             AND NOT EXISTS (SELECT 1 FROM conflict
                WHERE mutation_id = substr(meta.key, length('time_off_review_head:') + 1)
                AND resolved_at IS NULL)",
            [],
        )?;
        Ok(())
    }

    pub(crate) fn calendar_outbox(&self) -> Result<Vec<OutboxEntry>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {OUTBOX_COLS} FROM outbox
             WHERE (kind GLOB 'appointment.*' OR kind GLOB 'client.*' OR kind GLOB 'time_off.*')
               AND (
                 NOT EXISTS (SELECT 1 FROM meta WHERE key = 'assignment_ack:' || mutation_id)
                 OR CASE
                 WHEN kind = 'client.create' THEN
                   (SELECT value FROM meta WHERE key = 'client_directory') IS NOT 'denied'
                   AND NOT EXISTS (SELECT 1 FROM client WHERE id = outbox.entity_id)
                 WHEN kind = 'time_off.create' THEN
                   NOT EXISTS (SELECT 1 FROM time_off WHERE id = outbox.entity_id)
                 WHEN kind = 'time_off.update' THEN NOT EXISTS (
                     SELECT 1 FROM time_off
                     WHERE id = outbox.entity_id
                       AND julianday(json_extract(json, '$.updatedAt')) > coalesce(
                         julianday(json_extract(payload, '$.expectedUpdatedAt')),
                         julianday(outbox.created_at, '-0.001 seconds'))
                   )
                 WHEN kind = 'time_off.delete' THEN 1
                 ELSE NOT EXISTS (
                     SELECT 1 FROM appointment
                     WHERE id = outbox.entity_id AND version > coalesce(json_extract(payload, '$.version'), 0)
                   )
                 END
               )
             ORDER BY seq"
        ))?;
        Ok(stmt
            .query_map([], outbox_from_row)?
            .collect::<rusqlite::Result<_>>()?)
    }

    pub(crate) fn has_acknowledged_time_off(&self, id: &str) -> Result<bool> {
        Ok(self.conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM outbox WHERE entity_id = ?1
               AND kind IN ('time_off.create', 'time_off.update')
               AND EXISTS (SELECT 1 FROM meta WHERE key = 'assignment_ack:' || mutation_id))",
            [id],
            |row| row.get(0),
        )?)
    }

    pub(crate) fn queued_client_display_name(&self, id: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row(
                "SELECT json_extract(payload, '$.name') FROM outbox
             WHERE entity_id = ?1 AND kind = 'client.create' ORDER BY seq DESC LIMIT 1",
                [id],
                |row| row.get(0),
            )
            .optional()?
            .flatten())
    }

    pub(crate) fn conflicted_appointment_ids(&self) -> Result<HashSet<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT entity_id FROM conflict WHERE kind GLOB 'appointment.*' AND resolved_at IS NULL"
        )?;
        Ok(stmt
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?)
    }

    pub(crate) fn push_snapshot(&self, limit: usize) -> Result<(String, Vec<OutboxEntry>)> {
        let tx = self.conn.unchecked_transaction()?;
        let generation = Self::generation_at(&tx)?;
        let mut batch = if Self::meta_at(&tx, REBUILD_KEY)?.is_none() {
            Self::outbox_at(
                &tx,
                limit,
                Self::salon_configuration_ack(&tx)?
                    .as_ref()
                    .map(|ack| ack.mutation_id.as_str()),
                true,
            )?
        } else {
            Vec::new()
        };
        // Predicted versions for the same appointment are valid only after the prior edit applies.
        let mut appointments = HashSet::new();
        if let Some(dependent) = batch.iter().position(|entry| {
            entry.kind.starts_with("appointment.") && !appointments.insert(&entry.entity_id)
        }) {
            batch.truncate(dependent);
        }
        tx.commit()?;
        Ok((generation, batch))
    }

    fn outbox_at(
        conn: &Connection,
        limit: usize,
        skip: Option<&str>,
        for_push: bool,
    ) -> Result<Vec<OutboxEntry>> {
        let mut stmt = conn.prepare(&format!(
            "SELECT {OUTBOX_COLS} FROM outbox
             WHERE (?2 IS NULL OR mutation_id != ?2)
               AND (NOT ?3 OR NOT EXISTS (SELECT 1 FROM meta WHERE key = 'assignment_ack:' || mutation_id))
             ORDER BY seq LIMIT ?1"
        ))?;
        Ok(stmt
            .query_map(params![limit as i64, skip, for_push], outbox_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn outbox_len(&self) -> Result<usize> {
        Ok(self
            .conn
            .query_row("SELECT COUNT(*) FROM outbox", [], |r| r.get::<_, i64>(0))?
            as usize)
    }

    fn keeps_calendar_projection(tx: &Transaction, entry: &OutboxEntry) -> Result<bool> {
        if entry.kind.starts_with("appointment.") || entry.kind.starts_with("time_off.") {
            return Ok(true);
        }
        if entry.kind != "client.create" {
            return Ok(false);
        }
        Ok(tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM outbox WHERE kind = 'appointment.create'
                           AND json_extract(payload, '$.clientId') = ?1)",
            [&entry.entity_id],
            |r| r.get(0),
        )?)
    }

    fn acknowledge_outbox(tx: &Transaction, entry: &OutboxEntry, through: i64) -> Result<()> {
        Self::set_meta_at(
            tx,
            &format!("assignment_ack:{}", entry.mutation_id),
            &through.to_string(),
        )
    }

    /// Records the server's verdicts for a batch in order. Rejections become conflicts.
    /// Confirmed projections leave the send queue and stay visible until the pull catches up.
    /// The first retry and everything after it stay queued.
    pub fn apply_push_results(
        &mut self,
        sent: &[OutboxEntry],
        results: &[MutationResult],
    ) -> Result<PushApplied> {
        self.apply_push_results_in(sent, results, None, None)
    }

    pub(crate) fn apply_push_results_in(
        &mut self,
        sent: &[OutboxEntry],
        results: &[MutationResult],
        generation: Option<&str>,
        response_head: Option<i64>,
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
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        Self::ensure_generation(&tx, generation)?;
        let mut out = PushApplied::default();
        for (s, r) in sent.iter().zip(results) {
            let inventory_mutation = matches!(
                s.kind.as_str(),
                crate::product_editor::CREATE
                    | crate::product_editor::UPDATE
                    | crate::product_editor::PHOTO
                    | crate::inventory_documents::SUPPLIER_SAVE
                    | crate::inventory_documents::RECEIVE_STOCK
                    | crate::purchase_orders::PURCHASE_ORDER_WRITE
                    | crate::warehouses::SAVE
                    | crate::warehouses::TRANSFER
                    | crate::warehouses::ADJUST
                    | crate::inventory_classifications::SAVE
                    | crate::inventory_classifications::REORDER
                    | crate::inventory_classifications::BRAND_LOGO
            );
            match r {
                MutationResult::Applied { applied_seq, .. } => {
                    if s.kind == crate::service_resources::MUTATION_KIND {
                        Self::acknowledge_service_resources_at(&tx, s)?;
                    }
                    if s.kind == crate::inventory_classifications::REORDER {
                        Self::acknowledge_inventory_order_at(&tx, s)?;
                    }
                    if s.kind == "appointment.create" {
                        tx.execute(
                            "INSERT OR REPLACE INTO local_booking_confirmation (appointment_id,applied_seq)
                             VALUES (?1,?2)",
                            params![s.entity_id, applied_seq],
                        )?;
                    }
                    if matches!(
                        s.kind.as_str(),
                        "appointment.create" | "appointment.reschedule" | "appointment.cancel"
                    ) && let Some(seq) = applied_seq
                    {
                        calendar_notices::remember_applied(&tx, s, *seq)?;
                    }
                    if let Some(head) = response_head
                        && Self::keeps_calendar_projection(&tx, s)?
                    {
                        Self::acknowledge_outbox(&tx, s, applied_seq.unwrap_or(head))?;
                    } else if let Some(through) = response_head
                        && s.kind == "settings.update"
                        && s.payload.get("expectedRevision").is_some()
                    {
                        let ack = SalonConfigurationAck {
                            mutation_id: s.mutation_id.clone(),
                            through: through.max(applied_seq.unwrap_or(0)),
                        };
                        Self::set_meta_at(
                            &tx,
                            SALON_CONFIGURATION_ACK,
                            &serde_json::to_string(&ack)?,
                        )?;
                    } else if let Some(through) = response_head
                        && (inventory_mutation
                            || matches!(
                                s.kind.as_str(),
                                service_assignments::KIND
                                    | SERVICE_CREATION_KIND
                                    | SERVICE_EDIT_KIND
                                    | crate::service_resources::MUTATION_KIND
                                    | crate::resource_pools::CREATE
                                    | crate::resource_pools::UPDATE
                                    | crate::combinations::CREATE
                                    | crate::combinations::UPDATE
                                    | crate::http::PORTFOLIO_UPLOAD
                            ))
                    {
                        Self::acknowledge_outbox(&tx, s, through.max(applied_seq.unwrap_or(0)))?;
                    } else {
                        tx.execute(
                            "DELETE FROM outbox WHERE mutation_id = ?1",
                            [&s.mutation_id],
                        )?;
                    }
                    out.applied += 1;
                }
                MutationResult::Rejected {
                    reason, message, ..
                } => {
                    if reason == "forbidden" && inventory_mutation {
                        Self::apply_inventory_access_at(&tx, false)?;
                    }
                    if reason == "forbidden"
                        && matches!(
                            s.kind.as_str(),
                            SERVICE_EDIT_KIND
                                | SERVICE_CREATION_KIND
                                | crate::http::PORTFOLIO_UPLOAD
                                | service_assignments::KIND
                                | crate::service_resources::MUTATION_KIND
                                | crate::resource_pools::CREATE
                                | crate::resource_pools::UPDATE
                                | crate::combinations::CREATE
                                | crate::combinations::UPDATE
                        )
                    {
                        Self::forget_catalogue_access_at(&tx)?;
                    }
                    tx.execute(
                        "DELETE FROM outbox WHERE mutation_id = ?1",
                        params![s.mutation_id],
                    )?;
                    // A second rejected edit to the same appointment is still the user's work.
                    tx.execute(
                        "INSERT INTO conflict (mutation_id, kind, entity_id, payload, reason, message, created_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                         ON CONFLICT(mutation_id) DO NOTHING",
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
                    out.rejected += 1;
                    if let Some(head) = response_head
                        && reason == "conflict"
                        && matches!(s.kind.as_str(), "time_off.update" | "time_off.delete")
                    {
                        Self::set_meta_at(
                            &tx,
                            &format!("time_off_review_head:{}", s.mutation_id),
                            &head.to_string(),
                        )?;
                    }
                    if s.kind.starts_with("appointment.") {
                        let last_sent = sent.last().map_or(s.seq, |entry| entry.seq);
                        let moved = tx.execute(
                            "INSERT INTO conflict (mutation_id, kind, entity_id, payload, reason, message, created_at)
                             SELECT mutation_id, kind, entity_id, payload, 'conflict',
                                    'Review this edit after an earlier appointment change was rejected', created_at
                             FROM outbox WHERE seq > ?1 AND entity_id = ?2 AND kind GLOB 'appointment.*'
                             ORDER BY seq ON CONFLICT(mutation_id) DO NOTHING",
                            params![last_sent, s.entity_id],
                        )?;
                        tx.execute(
                            "DELETE FROM outbox WHERE seq > ?1 AND entity_id = ?2 AND kind GLOB 'appointment.*'",
                            params![last_sent, s.entity_id],
                        )?;
                        out.rejected += moved;
                    }
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
        Ok(self
            .conflicts()?
            .into_iter()
            .find(|c| c.mutation_id == mutation_id))
    }

    pub fn resolve_conflict(&mut self, mutation_id: &str, resolution: &str) -> Result<()> {
        Self::resolve_conflict_at(&self.conn, mutation_id, resolution)
    }

    fn resolve_conflict_at(conn: &Connection, mutation_id: &str, resolution: &str) -> Result<()> {
        let n = conn.execute(
            "UPDATE conflict SET resolved_at = ?2, resolution = ?3,
             payload = CASE WHEN kind IN ('product.photo','portfolio.upload','inventory.brand_logo') THEN json_remove(payload, '$.imageBase64') ELSE payload END
             WHERE mutation_id = ?1 AND resolved_at IS NULL",
            params![mutation_id, now_iso(), resolution],
        )?;
        if n == 0 {
            return Err(CoreError::NotFound(format!("open conflict {mutation_id}")));
        }
        Ok(())
    }
}

mod portfolio;
mod service_assignments;
pub use service_assignments::{AssignmentSnapshot, AssignmentWork, ServiceAssignment};
mod combinations;
mod inventory_classifications;
mod inventory_documents;
mod product_editor;
mod resource_pools;
mod resource_requirements;
mod service_creation;
mod service_edit;
mod warehouses;
pub use service_creation::SERVICE_CREATION_KIND;
pub use service_edit::{PendingServiceEdit, SERVICE_EDIT_KIND};

#[cfg(test)]
mod tests;
