# ADR 0002: Data model, double-booking guard and availability

The original continuous professional-block exclusion below is extended by [ADR 0016](0016-professional-work-capacity.md). Current deployments use frozen active-work intervals and configured concurrent capacity; full client spans and physical-resource rules remain distinct.


Status: accepted (Phase 1)

## Context

Phase 1 introduces the relational model, the booking rules and the first REST endpoints. The same business logic must be reusable by the MCP server (Phase 6) and the sync endpoints (Phase 4), so it lives in transport-agnostic service modules.

## Decisions

### Schema

- **Keys and time.** UUIDv7 primary keys generated in application code (`Bun.randomUUIDv7()`), so clients can pre-assign ids; `timestamptz` for every instant. Column names are snake_case (Drizzle `casing`).
- **Soft delete.** `deleted_at` on every table that will be synchronised (service, staff, service_staff, working_hours, time_off, client_profile, appointment). `salon_settings` and `appointment_service` do not need tombstones.
- **Single-row settings.** `salon_settings.id` is pinned to 1 by a CHECK constraint. It stores the salon timezone (IANA), slot granularity, minimum notice and the booking horizon.
- **Auth links.** `staff_profile.user_id` and `client_profile.user_id` were nullable text columns without a foreign key in Phase 1; Phase 2 ([ADR 0003](0003-auth-rbac-sessions.md)) added the Better Auth tables and real, unique foreign keys.
- **Working hours** are recurring wall-clock ranges (`weekday` 0-6 with 0 = Sunday, `time` start and end, several ranges per day allowed). Wall-clock storage is what keeps hours stable across DST changes. **Time off** is a plain `[starts_at, ends_at)` pair of `timestamptz`.
- **Appointments** carry an integer `version` (optimistic concurrency, starts at 1, incremented by each update) and a status enum: `booked | completed | cancelled | no_show`.
- **Service snapshots.** `appointment_service` copies name, duration, buffer and price at booking time, so catalog edits never rewrite history. `service_id` stays as a nullable reference.
- Not built yet: `sync_change` and `reminder` (later phases). `audit_log` and the Better Auth tables arrived in Phase 2. Multi-location stays out of the model.

### Exclusion constraint (the source of truth)

A hand-written migration (`packages/db/drizzle/0001_appointment_no_overlap.sql`, registered in drizzle's journal) enables `btree_gist` and adds:

```sql
EXCLUDE USING gist (staff_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&)
WHERE (status <> 'cancelled' AND deleted_at IS NULL)
```

- It is enforced by the database, so it holds under any concurrency and for any client (REST, MCP, sync, direct SQL). Availability search is advisory only.
- Ranges are half-open (`[)`), so back-to-back appointments are legal.
- `completed` and `no_show` still block time (the slot was used); `cancelled` and soft-deleted rows free it.
- A CHECK constraint enforces `ends_at > starts_at`.
- SQLSTATE `23P01` is mapped to `409 slot_taken`; a stale `version` maps to `409 version_conflict`.
- **Advisory lock per staff calendar.** Concurrent inserts with partially overlapping ranges can deadlock inside Postgres (each waits for the other's uncommitted row). Writers therefore take `pg_advisory_xact_lock` per staff id first, so they queue instead. The constraint still has the final say; the lock only removes deadlocks.

### Multi-service duration and buffer

An appointment blocks `sum(duration_minutes + buffer_minutes)` over its services, in request order. Each service's buffer is cleanup time after that service. `ends_at` includes all buffers, so the exclusion constraint protects the whole blocked window, and the whole block (buffers included) must fit inside working hours when searching for slots. Rescheduling keeps the original block length.

Booking itself does not re-validate working hours or minimum notice: availability is advisory and front-desk staff may need to override it. The constraint is the only hard rule.

### Date and time library: built-in `Temporal`

Bun 1.4 ships `Temporal`, and TypeScript 7 provides its types (`lib: ["ESNext.Temporal"]`), so no dependency is added. `Temporal.PlainDate#toZonedDateTime` resolves salon-local wall-clock times with the IANA database, which makes DST gaps and overlaps correct (a 01:00-04:00 range on a spring-forward day is two real hours; on a fall-back day it is four). Alternatives considered: `date-fns` + `@date-fns/tz` and `@js-temporal/polyfill`, both extra dependencies for functionality the runtime already has. Trade-off: the API must run on Bun (it does); Node would need the polyfill.

### Availability computation

`computeAvailability` is a pure function in `apps/api/src/modules/availability/compute.ts`: working hours, time off, existing appointments, block length, timezone, granularity, minimum notice, horizon and "now" go in, slots come out. The slot grid starts at each working range's start and steps by the granularity in absolute time. Slots start at or after `now + min notice`, and dates beyond `max_days_ahead` (or in the past) have no slots.

### Layering and errors

`apps/api/src/modules/<module>/service.ts` holds business logic and throws `DomainError(code, message)`; `routes.ts` is a thin Hono layer that validates input with the Zod contracts. Errors always have the shape `{ "error": { "code", "message" } }` with codes `validation_error` (400), `not_found` (404), `slot_taken` / `version_conflict` / `invalid_state` (409) and `internal_error` (500); the code-to-status map lives in `@sob/contracts`.

### Testing

Integration tests use a real Postgres. Each package creates and migrates its own `sob_test_<suffix>` database on the server in `DATABASE_URL`, so packages that Turborepo runs in parallel never truncate each other's data. If Postgres is unreachable the tests fail with an explicit message; they never skip.

## Consequences

- Business rules are reusable from MCP and sync without touching HTTP code.
- Routes were open in this phase; Phase 2 added authentication and RBAC (ADR 0003).
- Slot search and booking can disagree under races by design; clients must handle `409 slot_taken`.
