# Sisters of Beauty — open-source Booksy alternative (plan)

Current expansion: [operational feature delivery checklist](FEATURE-EXPANSION.md). The owner has expanded the original v1 scope to include commerce and salon-growth features for a single business/location. Original v1 history below remains a record of the previous scope.

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

Each phase ends green (lint, typecheck, `bun test`, and the listed checks) and is committed with conventional commits, split into reviewable work units. Final status at release 0.1.0:

| #   | Phase                                                                                                  | Status                            | Caveats                                                                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------ | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | Foundations: monorepo, compose, CI, ADR 0001                                                           | Done                              | Production template: [`.env.example`](../.env.example); complete variable reference: [docs/env-reference.md](env-reference.md).                                                                                                                                                     |
| 1   | Data and core API: schema, exclusion constraint, availability, appointments, seed                      | Done                              | [ADR 0002](adr/0002-data-model-and-availability.md).                                                                                                                                                                                                                                |
| 2   | Auth and RBAC: Better Auth, Valkey sessions, rate limits, audit log                                    | Done                              | [ADR 0003](adr/0003-auth-rbac-sessions.md). No MFA, no account lockout beyond rate limiting.                                                                                                                                                                                        |
| 3   | Web: booking flow, account area, admin dashboard, design system                                        | Done                              | ADRs [0005](adr/0005-web-app.md), [0006](adr/0006-admin-dashboard.md), [0004](adr/0004-admin-api-and-reporting.md). Guest booking is out of scope; the week view shows one team member at a time.                                                                                   |
| 4   | Sync protocol: change log, push/pull/SSE                                                               | Done                              | [ADR 0007](adr/0007-sync-protocol.md), [sync-protocol.md](sync-protocol.md). Tombstones are never purged.                                                                                                                                                                           |
| 5   | Desktop client (GPUI)                                                                                  | Done for Linux v1                 | [ADR 0008](adr/0008-desktop-client.md). Signs in with a session cookie, not OAuth; week view, native selection/IME, dark theme and completed/no-show controls are implemented. No OS keyring, system installer or auto-update. Linux only, verified on the author's machine and CI. |
| 6   | MCP server and OAuth 2.1                                                                               | Done                              | [ADR 0009](adr/0009-oauth-and-mcp.md). Not tested against real third-party MCP hosts; the desktop OAuth swap is deferred (see below).                                                                                                                                               |
| 7   | Notifications                                                                                          | Done                              | [ADR 0010](adr/0010-notifications-and-reminders.md). SMS tested against a stubbed Twilio API only, never a real account.                                                                                                                                                            |
| 8a  | Hardening: account security, observability, backups, production compose, k6                            | Done                              | [ADR 0011](adr/0011-production-hardening.md), [operations.md](operations.md), [performance.md](performance.md). Load numbers come from one laptop.                                                                                                                                  |
| 8b  | Release readiness: visual QA, open-source files, self-hosting guide, release workflow, security review | Done, release workflow unverified | [visual-qa.md](visual-qa.md), [self-hosting.md](self-hosting.md), [security-review.md](security-review.md). `.github/workflows/release.yml` could not be run outside GitHub.                                                                                                        |

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
3. `k6 run k6/booking-contention.js` → exactly one successful booking per slot; SQL checks confirm no active professional unit overlap or capacity violation (full client spans may overlap during processing or configured parallel work).
4. Book through the web UI, see the appointment appear on the desktop client after sync.
5. Go offline on the desktop, create an appointment, reconnect → it syncs; create a conflicting one on web while offline → conflict UI appears.
6. Connect an MCP client, complete OAuth 2.1, call `find_availability` and `create_appointment`.

## Known limitations and roadmap

Not in 0.1.0, roughly in the order we would tackle them:

- **Multi-factor authentication** and account lockout beyond rate limiting (ADR 0003, 0011).
- **OpenTelemetry tracing.** Logs carry a request id and metrics are Prometheus-only.
- **Desktop OAuth login.** The first-party `sob-desktop` OAuth client is seeded, but `/sync/*` accepts session cookies only. Needed: a bearer branch in `requireAuth` for a `sync` resource and scope, token storage and refresh in `sob-core`, a loopback listener plus browser step in the GPUI login. This is a future authentication mechanism; the Linux v1 session flow is implemented and covered by real-API tests (ADR 0009).
- **Desktop platform extras.** OS keyring for the session, system installers/auto-update, macOS and Windows builds. The Linux archive includes the executable, license, usage guide, revision metadata and checksum.
- **Tombstone purge.** Deleted rows stay in the sync log forever so that a long-offline device cannot resurrect them; a safe purge needs per-device cursors (ADR 0007).
- **Multi-location.** The schema keeps `location_id` but nothing builds on it.
- **Online payments and deposits**, guest booking, loyalty and marketing campaigns (non-goals for v1).
- **OAuth extras**: an account screen to list and revoke grants, verified client identity (CIMD), DPoP (ADR 0009).
- **External release execution** awaits a repository and tag. Metadata validation and reproducible packaging are tested locally; publication is gated by CI and the required Linux desktop build. See [release.md](release.md).

## Open risks

- GPUI is pre-1.0: the dependency is pinned exactly (`=0.2.2`), expect upgrade work.
- Better Auth's OAuth plugin API moves between versions: the version is pinned.
- "Latest everything" raises breakage risk: exact pins in lockfiles, upgrades through Dependabot pull requests.
- Reminders by SMS need a provider and local regulatory checks ([notifications.md](notifications.md)).

## Release-readiness verification — 2026-11-15

The local production Compose smoke test passed with the pinned Bun 1.4.4 images: fresh migrations, owner bootstrap and sign-in, a client booking, duplicate rejection, public metrics isolation, security headers, non-root processes and read-only filesystems. Smoke runs now use unique projects and image tags, ignore deployment `.env` files, disable SMS and remove only their own resources. CI is configured to run this smoke test after the integration suite.

Uncached lint, TypeScript checks and production builds passed. The API passed 673 tests; web components and server helpers passed 604; contracts passed 113; the database package passed 47; deployment scripts and backup/restore passed 7. Rust formatting and Clippy passed, along with 102 core tests, 9 GPUI interaction tests and all 4 real-API headless sync tests. Five new regression tests cover smoke isolation and Turbo environment filtering, with failure observed before each corresponding correction. The restore test now proves the non-empty-target guard using an intact dump.

Functional Playwright coverage totals 169 passing cases across mobile and desktop, with 3 platform-specific skips; the 6 screenshot-capture cases were excluded from this final functional check. These results aggregate the completed mobile coverage, a separate desktop run and the corrected fixture rerun, because the combined process received SIGTERM after mobile completed. The desktop run exposed a calendar-audit fixture collision: light and dark reused a client name and could randomly book on the same day. Forcing both themes onto the same date reproduced the failure; unique client identities fixed it, and all 8 repeated theme/viewport combinations passed without relaxing axe assertions.

Load verification produced 10 bookings and 490 expected conflicts from 500 attempts, with zero overlaps and p95 784 ms (unchanged threshold: 1,000 ms); competing-work caveats are recorded in [performance.md](performance.md). Host-side checks used the installed Bun 1.4.5 canary, separately from the production-image smoke. Both production and full dependency audits now report no vulnerabilities; the exact esbuild override was checked with migration generation, builds and production images.

The repository has no remote, published release or production domain yet. No push, tag publication or external deployment was performed. The existing MIT license is unchanged. Before opening a real salon, configure stable secrets, the public domain and sender/SMTP, verify delivery and HTTPS on that host, and run the GitHub release workflow after configuring the repository.

## Completion pass — 2026-11-15

Implemented and verified with failing regression tests before production changes:

- Durable account mail: encrypted Postgres outbox, transaction-backed deduplication/throttling, renewable/fenced concurrent leases, expiry, capped retries, restart recovery, terminal payload scrubbing, retention, owner statistics and Prometheus gauges. Both the API and standalone worker drain it.
- Linux desktop: week view and staff selection, whole-week navigation, completed/no-show offline mutations with optimistic versions, native UTF-16 text input/IME, grapheme editing, selection/clipboard and persisted light/dark themes. GUI behavior is covered by GPUI's real deterministic input runtime.
- Release code: matching versions/changelog/tag validation, dirty-checkout/revision metadata, deterministic Linux archives and checksums, reusable CI on the requested tag, mandatory desktop artifact before container/release publication. Local preparation works without a remote or registry.

Final full checks: API **686**, web **604**, contracts **113**, database **47**, deployment scripts **24**, Playwright **175 passed / 3 platform skips** (all six capture cases included), Rust core **104**, GPUI **21**, and real-API sync **4**. Lint, types, production builds, Rust format and Clippy pass. The final pinned-Bun production smoke passes with migration `0008`; both JavaScript audits report zero vulnerabilities. The optimized Linux executable and archive/checksum also build successfully; a graphical launch under Xvfb is unverified because it lacks the required Vulkan/DRI3 presentation support. Subsequent focused checks and native packaging evidence are recorded in [release.md](release.md).

External configuration is deliberately pending: Git remote/repository, production domain/HTTPS and real sender/provider accounts. They are not code blockers and are not represented as completed deployments. Existing future product features above remain outside the Linux v1 release scope.
