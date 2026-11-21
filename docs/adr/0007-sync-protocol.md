# ADR 0007: Offline sync protocol

Status: accepted (Phase 4). Implements the "Offline sync" section of [PLAN.md](../PLAN.md). The wire-level spec for client authors is [sync-protocol.md](../sync-protocol.md).

## Context

The desktop front-desk client (Phase 5) must keep working offline: create, move and cancel appointments, edit clients, and converge with the server afterwards. One salon, a handful of devices. ElectricSQL/PowerSync were rejected as overkill; the protocol is three endpoints over the existing API.

## Decision summary

- **Write path:** `POST /sync/push` takes an ordered batch of mutations, each with a client-generated UUIDv7 `mutationId`. The server applies each one through the same service layer as REST and answers per mutation: `applied`, `rejected(reason)` or `retry`.
- **Read path:** every committed change to a synced row appends to `sync_change`. `GET /sync/pull?since=<seq>` returns the changes after a cursor. `GET /sync/stream` (SSE) nudges clients to pull.
- **Conflicts:** appointments are server-authoritative; everything else is last-writer-wins per row.

## The change log is written by the database, not by the application

`sync_change(seq, entity, row_id, op, created_at)` is filled by `CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED` on `appointment`, `appointment_service` (re-announces its parent), `client_profile`, `service`, `staff_profile`, `service_staff`, `working_hours`, `time_off` and `salon_settings`.

Why triggers rather than application code: the requirement is that EVERY write appends to the log in the same transaction, including REST/admin writes, Better Auth's profile creation, seeds and manual SQL. There are about twenty write sites; one forgotten `INSERT` is a silently diverging client. A trigger cannot be forgotten, and being in the same transaction it commits or rolls back with the write. Soft deletes (`deleted_at` set) and real `DELETE`s are logged as `op = delete` (tombstones).

The log carries no payload. Pull reads the row's current state. This keeps the log tiny, makes stale entries harmless (an old entry can never resurrect old data) and lets role filtering and DTO shaping live in one place (`pull.ts`). The price is one lookup per entity per page, which is trivial at this scale.

## Cursor safety: seq order equals commit order

The classic bug: a sequence is drawn when a row is inserted, but rows become visible when their transaction commits. Transaction A draws seq 10 and stays open; B draws 11 and commits; a reader sees 11, advances its cursor to 11, then A commits seq 10 behind the cursor and the client never sees it. `packages/db/src/sync.test.ts` reproduces exactly this with a naive log as a control.

Options considered:

1. **Read only below the lowest in-flight seq** (xmin-style horizon using `pg_snapshot_xmin`). Rejected: seq is drawn at insert time while xid is drawn at first write, so the two orders can still differ and the horizon is not sound without extra bookkeeping.
2. **Take a global advisory lock in an immediate trigger.** Sound, but the lock is held from the first write to commit, and it deadlocks against application locks (a transaction holding a row or calendar lock waits for the sync lock while another holds the sync lock and waits for that row).
3. **Deferred trigger: draw the seq at COMMIT time under a global advisory lock.** Chosen.

The trigger is a deferred constraint trigger, so it runs when the transaction asks to commit, after all its writes and after it has taken every row and calendar lock it will ever need. It then takes `pg_advisory_xact_lock(hashtextextended('sob.sync_change', 0))`, inserts into `sync_change` (drawing `seq`) and commits; Postgres makes the commit visible before it releases the lock. Therefore:

- seq order equals commit order, so if a reader has seen `seq = n`, every change that will ever commit with a lower seq is already visible. The last seq a reader saw is always a safe cursor.
- The lock is held for microseconds (the remaining triggers plus the commit), and the lock holder never waits for anything but its own commit, so it cannot take part in a deadlock cycle.
- A rolled-back transaction leaves a gap in `seq` (identity values are not transactional) but not a log row. Gaps are normal; clients must not assume contiguity.

Cost: commits of transactions that touch synced tables serialize on that lock. For one salon that is a few writes per second at most. Trade-off accepted; if it ever matters the log can be sharded or moved to logical decoding.

Tests: `sync.test.ts` (db) asserts commit-order seqs and that a concurrent poller sees every row; `cursor.test.ts` (api) runs slow REST-level transactions and pushes against a paging follower and requires no change to be missed. As a mutation check, replacing the trigger with an unlocked version that sleeps between insert and commit made the follower test fail (1 of 3 runs, the race is probabilistic); with the lock it passed every run.

## Idempotency

`sync_mutation(mutation_id PK, device_id, user_id, kind, status, result, applied_seq)` is the ledger. The server acquires an advisory lock derived from the mutation ID and checks the ledger. A savepoint groups the write, the applied receipt and validation of deferred constraints after the application has acquired its write locks. The sync trigger fills `applied_seq` using the transaction-local setting `sob.mutation_id`. A domain rejection rolls back to the savepoint and records the rejected receipt while the outer transaction still holds the mutation lock. Concurrent deliveries replay the committed receipt. Rejections are final. To retry after review, the client issues a new `mutationId`. Another user's ID yields `invalid` without revealing the stored result.

Unexpected errors (database down, bugs) are not stored: the mutation comes back as `retry`, the rest of the batch is also `retry` (order is preserved), and the client resends the same mutation with backoff.

Mutations in a batch run in outbox order, each in its own transaction. Desktop waits for the receipt before sending a second edit to the same appointment. If the first edit is rejected, Desktop moves the dependent edits to its conflict inbox. The server also rejects later edits based on a higher version after a rejection for that appointment in an older client's batch. An independent edit for an appointment that has yet to be created is rejected as `not_found`.

## Conflict policy

- **Appointments are server-authoritative.** Create, reschedule, cancel and status changes go through the exact service layer REST uses: working hours, time off, notice window, RBAC policy, optimistic `version`, the per-calendar advisory lock and the exclusion constraint. Failures map to rejection reasons: `slot_taken` (exclusion constraint), `slot_unavailable`, `conflict` (stale `version`), `invalid_state`, `not_found`, `forbidden`, `invalid`. Nothing is ever silently dropped: the client must surface each rejection (reschedule or cancel) in the UI.
- **Last-writer-wins for the remaining legacy edits** (clients including notes, time off, services, staff and flat settings patches). Each mutation carries `createdAt`, the time the user made the edit. It is clamped to the server clock and compared with the row's `updated_at`. A strictly newer edit wins and the row's `updated_at` becomes the edit time. Older edits and ties are rejected as conflicts. Deleted rows are not resurrected by edits. [ADR 0022](0022-reviewed-offline-salon-settings.md) defines revision checks for reviewed settings patches.
- `updated_at` is therefore the LWW clock of the row, the time of the last edit as seen by its writer.

## Visibility and tombstones

Owner sees everything. Staff see appointments, working hours and time off of their own calendar only (the same policy as REST), all clients, services, staff and salon settings; the staff login link (`userId`) is owner-only. A row that is deleted, or exists but is not visible to the caller, is announced as a tombstone (`op = delete`, `data = null`). This also covers an appointment moved to another calendar: the previous owner's client removes it. A tombstone for a never-seen row is a harmless no-op. Clients must apply tombstones idempotently.

Pull collapses multiple log entries for the same row inside one page into the latest one. `limit` bounds the log rows scanned (default 200, max 500); the cursor always advances over everything scanned, so pages that are fully filtered out do not stall.

A cursor ahead of the server's head (database restored from a backup) is refused with `409 invalid_state`; the client discards its replica and resyncs from `since=0`. The migration backfills the log with all pre-existing rows, so `since=0` is always a full snapshot.

## Tombstone retention and compaction

`compactSyncLog(db, { olderThan })` deletes log entries older than the cutoff that a later entry for the same row supersedes. It never deletes a row's newest entry (so `headSeq`, tombstones and every issued cursor stay valid) and leaves only gaps in `seq`; a client at any older cursor still converges, because pull serves current state. It is a library function with tests; scheduling it (for example daily, 30-day cutoff) belongs to Phase 8 operations.

**Tombstones are not purged yet.** Purging them is what would let a client offline longer than the retention keep a ghost row. The planned design: record a `tombstone_floor` seq when purging and make pull answer `409 resync_required` for cursors below it, forcing a full resync. Until then the log grows by one row per soft-deleted entity, which is negligible, and no client can diverge.

## Realtime nudge

After every mutating request (any non-GET, including `/sync/push`, REST admin writes and sign-up), the API publishes the committed head seq on a Valkey channel (`<prefix>sync:nudge`). Each process holds one lazily opened subscriber connection and fans out to its SSE connections. The nudge carries no data, only "pull"; a lost nudge is harmless because clients also pull on reconnect and on a slow timer. Writes made outside the API (scripts, psql) do not nudge. The stream sends the current head on connect and `: ping` comments as heartbeat (default 15 s). It is authenticated (owner and staff), rate limited per caller (`SYNC_STREAM_RATE_LIMIT_MAX`, default 30 connections per 60 s) and ends cleanly on `app.shutdown()` (wired to SIGTERM/SIGINT) so deploys do not leave hanging streams.

## Consequences

- Phase 5 can implement the client from `docs/sync-protocol.md` without reading server code.
- Any new synced table needs a trigger in a migration plus a case in `pull.ts` (the entity list lives in `@sob/db` and `@sob/contracts`).
- Commit serialization on synced writes is a known scalability ceiling, documented above.
- Not covered: multi-location, per-field merge, client-side schema migration.
