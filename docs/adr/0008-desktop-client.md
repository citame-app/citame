# ADR 0008: Desktop client (GPUI), local replica and auth

Status: accepted (Phase 5)

## Context

The front desk needs a client that keeps working without a connection: look at the day's calendar, book, move and cancel, and reconcile with the server when the network returns. The sync protocol (ADR 0007, [docs/sync-protocol.md](../sync-protocol.md)) is already on the server; this ADR records how the Rust client implements it. The UI framework was chosen by the user: GPUI.

## Decisions

### Layout: a cargo workspace with a GUI-free core

`apps/desktop` is a cargo workspace (not a Bun workspace member: it has no `package.json`, so Turborepo and `bun install` do not see it).

- `crates/core` (`sob-core`): everything that is not drawing. SQLite store, outbox, sync engine, runner, HTTP transport, SSE listener, auth, calendar read model, i18n table. No GPUI dependency, so `cargo test -p sob-core` is fast and runs on any CI box without graphics libraries.
- `crates/app` (`sob-desktop`): the GPUI shell (login, day calendar, dialogs). It only renders and forwards user intent to `sob-core`.

The protocol shapes are written by hand in `model.rs` (the server's source of truth is `packages/contracts/src/sync.ts`); the headless test against the real API is what keeps them honest.

### GPUI: `gpui = "=0.2.2"` from crates.io, not a git SHA

PLAN.md assumed a git dependency pinned to a Zed commit. Today `gpui` is published on crates.io, so the dependency is the exact version `=0.2.2` and `Cargo.lock` (committed) pins its checksum. That is a stronger pin than a SHA (no 1 GB+ git checkout of the Zed monorepo, reproducible from the registry). Trade-off: crates.io releases lag Zed's `main`, so newer GPUI features arrive later; revisit when a needed API is missing.

`gpui-component` (widget library) is not used. Its published versions track different GPUI revisions, and v1 needs only buttons, chips, one text field and a grid, which are about 150 lines here.

One patch is needed to build on a current toolchain: `xattr 0.2.3` (reached through `gpui -> gpui_http_client -> zed-async-tar`) references `libc::ENOATTR`, which libc no longer exports for Linux/glibc. `apps/desktop/vendor/xattr` is the upstream crate with that single constant changed to `ENODATA` (the Linux errno for the same condition), wired through `[patch.crates-io]`. Remove it when gpui moves to a fixed xattr.

The text field is hand-written (typing, backspace, paste, tab, enter): no selection or IME. Acceptable for v1 forms (names, notes); a real text input is a follow-up.

### Local schema (rusqlite, bundled SQLite, WAL)

Migrations are an ordered list applied inside transactions and tracked with `PRAGMA user_version` (currently 1).

| Table                                                                                                       | Purpose                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `meta`                                                                                                      | `device_id` (UUIDv7, generated once, sent as `deviceId`) and `cursor`                                                                                                                                             |
| `client`, `service`, `staff`, `service_staff`, `working_hours`, `time_off`, `salon_settings`, `appointment` | Server mirror: primary key `id`, the validated wire JSON, plus extracted columns only where queries need them (`appointment`: staff, start and end in epoch ms, status, version; `time_off`: range)               |
| `outbox`                                                                                                    | Pending mutations: autoincrement `seq` (creation order), `mutation_id` (UUIDv7, fixed when the user acts), `created_at` (fixed, reused on every resend), `kind`, `entity_id`, `payload`, `attempts`, `last_error` |
| `conflict`                                                                                                  | Rejected mutations awaiting the user: reason, server message, the original payload, `resolved_at` and `resolution`                                                                                                |

Rules that follow from the protocol:

- A pull page and the cursor are written in one transaction, and the cursor only moves forward (`MAX`), so a crash can neither skip nor lose changes. Upserts are by primary key (idempotent), tombstones delete (no-op when absent), unknown entities from a newer server are skipped but the cursor advances.
- `409 invalid_state` on pull (cursor ahead of the server, restored backup) drops the mirror and the cursor and resyncs from 0; the outbox, the open conflicts and the device id are kept because they are the user's work.
- **The mirror holds server state only.** Local edits are layered on top at read time (`calendar::overlay` replays the outbox in order over the mirror rows). Consequences: a pull can never clobber a pending edit (the protocol's "keep showing the local version until acknowledged"), a rejection leaves no phantom row to clean up, and "pending sync" is simply "this appointment has an outbox entry". The overlay also bumps the local `version` per queued mutation, which is how `ops` produces the consecutive versions the server expects for several edits of one appointment.
- Rejected results leave the outbox and become `conflict` rows, never silent. If an entity already has an open conflict, later rejections for it (typically `not_found` for dependents of a rejected create) are dropped instead of piling up.

### Sync engine

`sync::push_outbox` sends batches of up to 100 in creation order, strictly one request at a time (the engine is synchronous, so concurrency is impossible by construction). Results are checked to match the batch one-to-one and in order. `applied` and `rejected` leave the outbox; the first `retry` and everything after it stay and the cycle ends with a transient error. `sync_cycle` is push, then pull until `hasMore` is false (a server that says `hasMore` without advancing the cursor is a protocol error, so the client cannot spin).

Errors follow the protocol table (`TransportError` -> `SyncError`): network and 5xx are offline/retry, `429` honors `Retry-After` as a floor, `401` means sign in again, `403` and `400` are never retried and nothing is dropped on any error. Resends are byte-identical, so replays come back `replayed: true`.

`runner` owns one worker thread with its own SQLite connection (the UI has another; WAL lets them coexist). It cycles on start, on local edits, on SSE nudges that are news (`seq` beyond the cursor, or work pending), on "sync now" and on a 60 s timer (the polling fallback). Failures back off exponentially with full jitter (base 1 s, factor 2, cap 60 s), reset on success. It publishes a `SyncStatus` (online/offline/connecting/auth required, syncing, last sync, pending and conflict counts, retry countdown, stream live) that the UI polls every 400 ms and uses for the offline indicator and badges.

The SSE listener (`GET /sync/stream`) reconnects with the same backoff. ureq bounds the whole body rather than each read, so the stream is deliberately cycled every 90 s; the initial `change` event on connect is filtered by the "is it news" check, so a cycle costs one cheap connect and no pull.

### Conflicts

Appointments are server-authoritative. A rejected appointment mutation becomes a conflict the user resolves in the UI:

- **Pick another time** (and staff): a rejected create is re-sent as a new `appointment.create` with the same appointment id and a NEW `mutationId` (rejections are final server-side); a rejected move becomes a new reschedule with the fresh server version.
- **Drop the booking / cancel the appointment**: a rejected create is just discarded; for an existing appointment a cancel is queued.
- **Dismiss**: close the notice (for example a stale `conflict` on an edit; the calendar already shows the server copy).

Bookings are validated locally against the synced catalog before queueing (unknown service or client, a staff member who does not perform every selected service), so avoidable rejections never leave the desk. The server stays the judge for everything else.

### Authentication and offline access

The native client uses the selected server’s browser sign-in, OAuth authorization code with PKCE, and a bearer token scoped to desktop sync and supported routes. Tokens are refreshed by the shared transport and stored in the profile’s private session file. Earlier saved cookie sessions remain usable until the next sign-in. See [ADR 0009](0009-oauth-and-mcp.md).

A saved profile opens offline. If the server explicitly denies sync or reports a different account role, the app returns to sign-in and preserves the old profile’s queue. Local files remain scoped to the server, account and role.

### i18n

All UI copy lives in `sob_core::i18n` (a macro-generated `Key` enum with an English and a neutral es-AR string each, so a missing translation is a compile error). Locale comes from `SOB_LANG` or `LANG`, English unless Spanish.

### Testing strategy

- `cargo test -p sob-core`: unit tests per module (store, outbox ordering, idempotent replay, offline create/move/cancel, conflicts, tombstones, cursor persistence, backoff, runner status, HTTP classification over loopback sockets, SSE).
- `crates/core/tests/headless_sync.rs`: `#[ignore]`d tests against the REAL API, Postgres and Valkey (no server mock): offline create, reconnect, visible on a second device and over REST; a conflicting booking made on another desk surfaces as a `slot_taken` conflict and is resolved by rescheduling; idempotent replay; tombstones; SSE nudge waking the runner.
- `cargo test -p sob-desktop`: GPUI's deterministic test runtime drives the real `Root` view (booking, validation, move and cancel, conflict resolution, sign out) over a real SQLite replica.

## Consequences

- The Rust toolchain (stable, edition 2024) and, for the GUI crate, the system libraries GPUI needs on Linux (Wayland/X11, xkbcommon, fontconfig, Vulkan loader) are required to build `sob-desktop`; `sob-core` needs only a C compiler (bundled SQLite) and, for TLS, the ring build prerequisites.
- The original v1 UI edited appointments and created clients. The sync layer carries the original last-writer-wins edits as well. Native settings use the reviewed queue defined in [ADR 0022](0022-reviewed-offline-salon-settings.md).
- Added in the 2026-11-15 release-readiness pass: day/week navigation with one staff member per week, native UTF-16/IME text input with grapheme editing and selection, persisted light/dark theme with system default, and completed/no-show controls backed by versioned offline mutations.
- Initially deferred in v1: OS keyring, system installers and auto-update, and macOS/Windows builds. [ADR 0020](0020-desktop-release-platforms.md) updates the platform release decision.
