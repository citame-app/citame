# Sisters of Beauty — open-source Booksy alternative (plan)

## Context

Sisters of Beauty needs a booking and salon-management platform in the spirit of Booksy: online booking for clients, a calendar and CRM for the salon, and reminders. It will be open source, self-hosted with Docker, and use a single modern TypeScript stack plus a **client-first, offline-capable desktop app** for the salon's front desk (GPUI, chosen by the user).

The repo (`/home/gnurub/code/sistersofbeauty_citame`) is empty apart from `.node_version` and `.atl/` (no commits). Local toolchain verified: bun 1.4.4, node 24.21.0 (setup of other tools used 24.22.3), docker 26.1.0, cargo 1.98.1, k6 2.2.0.

"Everything latest" means: pin exact versions at scaffold time (`bun add <pkg>@latest`, then commit the lockfile) and re-check docs with Context7 before using each library's API. Do not copy versions from this plan.

## Scope

**v1 (in):** single salon (single-tenant, one or more staff), service catalog, staff schedules and time off, availability search, online booking by clients, appointment management by staff, client CRM (notes, history), email/SMS reminders, basic reports (charts), desktop front-desk client with offline sync, MCP server so AI agents can query/book on behalf of authenticated users.

**Out (non-goals for v1):** multi-tenant marketplace, online payments/deposits, marketplace discovery, mobile apps, loyalty/marketing campaigns. Schema keeps a `location_id` so multi-location is possible later, but nothing builds on it now.

## Architecture

```
apps/
  api/        Hono (Bun) — REST + sync endpoints + MCP (Streamable HTTP) + Better Auth routes
  web/        TanStack Start — public booking site + staff/owner admin dashboard
  desktop/    Rust + GPUI — front-desk client (local SQLite, outbox, sync)
packages/
  db/         Drizzle schema, migrations, seed
  contracts/  Zod schemas + inferred types shared by api/web/mcp (single source of truth)
  config/     tsconfig, lint/format config
k6/           load and contention scenarios
docker/       Dockerfiles, compose files
docs/         PLAN.md (copy of this plan), ADRs, API/sync spec
```

- **Runtime/tooling:** Bun workspaces, **Turborepo as the task runner** (task graph, caching, `turbo prune --docker`), `bun test`, TypeScript strict, Biome for lint and format. See [ADR 0001](adr/0001-stack-and-monorepo.md).
- **Data:** Postgres + Drizzle (migrations via drizzle-kit). Valkey for sessions/secondary storage, rate limiting, SSE/pub-sub fan-out and the reminder job queue. Use Bun's built-in Redis client against Valkey; fall back to `iovalkey` if a needed command is missing.
- **Web:** TanStack Start + Router + Query; Store for UI state; Table for admin grids; **TanStack DB** for local-first collections in the admin UI; Tailwind CSS. Charts: TanStack has no chart library, so use Recharts (assumption — change if you prefer another).
- **Auth:** Better Auth (Drizzle adapter, Valkey secondary storage). Roles: `owner`, `staff`, `client`. The same instance is the **OAuth 2.1 authorization server** (PKCE, consent) used by the MCP server and the desktop client. Pin the Better Auth version first: the docs disagree between `oauthProvider()` and `mcp()` plugins (v1.6 vs v1.8 beta) — read the docs for the exact installed version and use only one of them.
- **MCP server:** inside `apps/api`, Streamable HTTP, protected-resource metadata (RFC 9728), Bearer tokens from Better Auth. Tools reuse the same service layer as REST (no duplicated business rules). Initial tools: `list_services`, `find_availability`, `create_appointment`, `cancel_appointment`, `list_my_appointments`; staff-scoped: `list_schedule`, `find_client`.
- **Desktop (GPUI):** git dependency on the Zed repo (not on crates.io under the official name; pre-1.0 — pin a commit SHA). Optional `gpui-component` for widgets. Local SQLite (`rusqlite`), outbox table, background sync task, OAuth 2.1 PKCE via loopback redirect.

## Domain model (Drizzle, first cut)

`user` / `session` / `account` (Better Auth-managed), `staff_profile`, `client_profile`, `service` (duration, buffer, price), `service_staff` (who performs what), `working_hours` (recurring), `time_off`, `appointment` (staff_id, client_id, `starts_at`, `ends_at`, status, `version`), `appointment_service`, `reminder`, `audit_log`, `sync_change` (see below).

Conventions: UUIDv7 primary keys (generated client-side as well), `timestamptz` everywhere, salon timezone stored once in settings, soft-delete via `deleted_at` (needed for sync tombstones).

**Double-booking prevention (critical):** a Postgres exclusion constraint on `appointment` using `btree_gist` and `tstzrange(starts_at, ends_at)` per `staff_id`, excluding cancelled rows. Drizzle cannot express this natively, so it goes in a hand-written SQL migration. The API maps the constraint violation to a `409 slot_taken` response. Availability search is advisory; the constraint is the source of truth.

## Offline sync (client-first)

Custom, deliberately simple protocol (one salon, a handful of devices); ElectricSQL/PowerSync rejected as overkill and extra infra.

- **Write path:** the desktop applies changes to local SQLite immediately and appends them to an `outbox` with a client-generated `mutation_id` (UUIDv7). `POST /sync/push` takes a batch; the server is idempotent per `mutation_id` and returns per-mutation results (`applied | rejected(reason)`).
- **Read path:** every server-side change writes to `sync_change` (monotonic `seq`, table, row id, op). `GET /sync/pull?since=<seq>` returns changes and a new cursor; SSE (backed by Valkey pub/sub) nudges clients to pull.
- **Conflicts:** appointments are server-authoritative — an overlap rejection is surfaced in the desktop UI for the user to resolve (reschedule/cancel), never silently dropped. Other entities (client notes, service info) use last-writer-wins per row by `updated_at`/`version`. Deletes are tombstones.
- **Offline window:** the desktop can create/move/cancel appointments offline; they show as "pending sync" until acknowledged.

## Phases

Each phase ends green (lint, typecheck, `bun test`, and the listed checks) and is committed with conventional commits, split into reviewable work units.

0. **Foundations** — monorepo skeleton, tsconfig/lint, `docker compose` (postgres, valkey, api, web), `.env.example`, CI, ADR for the decisions above, copy this plan to `docs/PLAN.md`.
1. **Data + core API** — Drizzle schema and migrations (including the exclusion constraint), Hono app, service layer for services/staff/availability/appointments, Zod contracts, seed data for Sisters of Beauty.
2. **Auth + RBAC** — Better Auth, roles, Valkey secondary storage, rate limiting, audit log.
3. **Web** — public booking flow (service → staff → slot → confirm), client account area, owner/staff dashboard (calendar, clients, services, schedules, reports with charts), Tailwind design system.
4. **Sync protocol** — `sync_change`, push/pull/SSE endpoints, contract tests for idempotency, ordering and tombstones.
5. **Desktop client** — GPUI app shell, local SQLite + outbox, calendar view, create/move/cancel, sync engine, OAuth PKCE login, offline indicator and conflict resolution UI.
6. **MCP server** — OAuth 2.1 metadata and consent, tools listed above, tool-level authorization tests. *Done; see ADR 0009 (desktop OAuth swap deferred).*
7. **Notifications** — reminder scheduler (Valkey-backed queue), email provider adapter, optional SMS adapter behind an interface.
8. **Hardening and release** — k6 load/contention suites, backups doc, observability (structured logs, health checks), production compose, self-hosting guide, open-source files (LICENSE, CONTRIBUTING, SECURITY).

## Testing strategy

- `bun test`: unit tests for the service layer, availability computation (DST edges, buffers, time off), Zod contracts; integration tests against a real Postgres/Valkey from compose (no DB mocks).
- Exclusion-constraint test: concurrent inserts for the same staff/slot — exactly one succeeds.
- Sync contract tests: replayed `mutation_id`, out-of-order batches, tombstones, conflicting offline edits.
- k6: `availability` read-heavy scenario and `booking-contention` scenario (many VUs racing for the same slot; assert one 201, rest 409, zero double-bookings in DB).
- Rust: `cargo test` for the sync engine and local store; a headless sync test against a running API.
- MCP: end-to-end test with an MCP client doing the OAuth 2.1 flow, then calling tools.

## Verification (end to end)

1. `docker compose up -d` brings up postgres, valkey, api, web; `/health` is green.
2. `bun test` passes; then `bun run db:migrate && bun run db:seed` on a fresh DB.
3. `k6 run k6/booking-contention.js` → exactly one successful booking per slot; SQL check confirms no overlapping appointments.
4. Book through the web UI, see the appointment appear on the desktop client after sync.
5. Go offline on the desktop, create an appointment, reconnect → it syncs; create a conflicting one on web while offline → conflict UI appears.
6. Connect an MCP client, complete OAuth 2.1, call `find_availability` and `create_appointment`.

## Open risks

- GPUI is pre-1.0 and consumed from git: pin a commit SHA, expect upgrade work, budget time for missing widgets (date pickers, calendar grid are custom).
- Better Auth OAuth/MCP plugin API is in flux between versions: pin the version, read its docs at install time.
- "Latest everything" raises breakage risk: pin exact versions in lockfiles and upgrade deliberately.
- Reminders by SMS/email need a provider and, for SMS, local regulatory checks.

## Immediate next step on approval

Phase 0: scaffold the monorepo and compose stack, copy this plan to `docs/PLAN.md`, then commit with a conventional commit (no AI attribution, per user rules).
