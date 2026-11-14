# Sisters of Beauty

Open-source booking and salon-management platform (a Booksy alternative): online booking for clients, calendar and CRM for the salon, reminders, and an offline-capable desktop client for the front desk. Self-hosted with Docker.

The project is built in phases. See [docs/PLAN.md](docs/PLAN.md) for scope, architecture and roadmap, and [docs/adr](docs/adr) for decision records.

## Quickstart

Requirements: [Bun](https://bun.sh) 1.4+, Docker with Compose.

```sh
bun install
export BETTER_AUTH_SECRET="$(openssl rand -base64 32)"   # 32+ characters, keep it stable
docker compose up -d --wait postgres valkey
bun run db:migrate                    # schema, exclusion constraint, auth tables
bun run db:seed                       # idempotent sample data (generic placeholders)
OWNER_EMAIL=owner@example.com OWNER_PASSWORD='change-me-please' bun run bootstrap:owner   # idempotent
bun run dev                           # API on http://localhost:3000 and the web app on http://localhost:5173
```

Everything else defaults to the local compose services. Variables can live in a `.env` file (Bun and Compose both read it) or be exported; see the table below.

## Auth quickstart

Sign-up always creates a **client**. Staff accounts are created by the owner. A request that carries a cookie must send an `Origin` matching `BETTER_AUTH_URL` or `TRUSTED_ORIGINS`.

```sh
H=(-H "content-type: application/json" -H "origin: http://localhost:3000")

# Sign up (the response sets the session cookie), then read your profile
curl -si "${H[@]}" -c jar -X POST localhost:3000/api/auth/sign-up/email \
  -d '{"email":"lucia@example.com","name":"Lucia","password":"correct horse battery"}'
curl -s -b jar localhost:3000/me

# Sign in / out
curl -si "${H[@]}" -c jar -X POST localhost:3000/api/auth/sign-in/email \
  -d '{"email":"lucia@example.com","password":"correct horse battery"}'
curl -si "${H[@]}" -b jar -X POST localhost:3000/api/auth/sign-out -d '{}'

# The owner (signed in with their own cookie jar) creates a staff account
curl -s "${H[@]}" -b owner-jar -X POST localhost:3000/admin/staff-accounts \
  -d '{"email":"ana@example.com","name":"Ana","password":"a long enough password"}'
```

Anonymous `POST /appointments` is rejected with `401 unauthorized`: guest booking is out of scope for v1 (see [ADR 0003](docs/adr/0003-auth-rbac-sessions.md)).

## API

| Method       | Path                                                       | Access                                  | Purpose                                                                                                                                                                                                                                                                                                   |
| ------------ | ---------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET          | `/health`                                                  | public                                  | Liveness                                                                                                                                                                                                                                                                                                  |
| GET          | `/salon`                                                   | public                                  | Salon name, timezone and booking window                                                                                                                                                                                                                                                                   |
| GET          | `/services`                                                | public                                  | Active service catalog                                                                                                                                                                                                                                                                                    |
| GET          | `/staff`                                                   | public                                  | Active staff and the services they perform                                                                                                                                                                                                                                                                |
| GET          | `/availability?serviceIds=a,b&staffId=&date=YYYY-MM-DD`    | public                                  | Bookable slots (`staffId` optional)                                                                                                                                                                                                                                                                       |
| GET/POST     | `/api/auth/*`                                              | public, strictly rate limited           | Better Auth: sign-up, sign-in, sign-out, session                                                                                                                                                                                                                                                          |
| GET/PATCH    | `/me`                                                      | signed in                               | Role, linked profile ids and phone / edit your name and phone                                                                                                                                                                                                                                             |
| GET/PATCH    | `/me/notification-preferences`                             | client                                  | Message language and per channel/category switches (SMS is opt-in)                                                                                                                                                                                                                                        |
| GET/POST     | `/notifications/opt-out?token=`                            | public (signed link)                    | GET describes, POST switches email reminders off; accepts RFC 8058 one-click                                                                                                                                                                                                                              |
| GET          | `/admin/notifications/stats`                               | owner                                   | Reminder queue depth per status and worker counters                                                                                                                                                                                                                                                       |
| POST         | `/appointments`                                            | client, staff, owner                    | Book; enforces hours, time off, notice and horizon (409 `slot_unavailable`); 409 `slot_taken` on overlap; `override: true` skips min notice (staff, owner)                                                                                                                                                |
| PATCH        | `/appointments/:id`                                        | the client, the calendar's staff, owner | Reschedule (same rules and notice override as booking, 409 `slot_unavailable`) or set `status`: `cancelled` (client too), `completed` / `no_show` (staff, owner, once started; corrections owner only). Needs the current `version` (409 `version_conflict`); invalid transitions are 409 `invalid_state` |
| GET          | `/appointments?from=&to=&staffId=&status=&page=&pageSize=` | signed in                               | Role-filtered, paged (`status` is comma-separated); returns `page`, `pageSize`, `total`                                                                                                                                                                                                                   |
| GET          | `/appointments/calendar?from=&to=&staffIds=`               | staff (own), owner                      | Day/week calendar in one call: appointments with client and service names, time off, working windows (max 42 days)                                                                                                                                                                                        |
| POST         | `/admin/staff-accounts`                                    | owner                                   | Create a staff login and calendar                                                                                                                                                                                                                                                                         |
| PATCH        | `/admin/users/:id/role`                                    | owner                                   | Change a role; not your own; 409 `has_future_appointments` when demoting staff with upcoming bookings                                                                                                                                                                                                     |
| GET/POST     | `/admin/services`                                          | owner                                   | List all services (inactive too) / create one                                                                                                                                                                                                                                                             |
| PATCH/DELETE | `/admin/services/:id`                                      | owner                                   | Edit (including `active`) / soft-deactivate                                                                                                                                                                                                                                                               |
| PUT          | `/admin/services/:id/staff`                                | owner                                   | Replace who performs the service (`{ staffIds }`)                                                                                                                                                                                                                                                         |
| GET          | `/admin/staff`                                             | staff (self), owner                     | Staff profiles including inactive ones                                                                                                                                                                                                                                                                    |
| PATCH        | `/admin/staff/:id`                                         | owner                                   | Rename, (de)activate; 409 `has_future_appointments` on deactivation                                                                                                                                                                                                                                       |
| GET/PUT      | `/admin/staff/:id/working-hours`                           | read: self, owner; write: owner         | Weekly hours (PUT replaces all); response lists `conflicts` with existing bookings                                                                                                                                                                                                                        |
| GET/POST     | `/admin/staff/:id/time-off`                                | self, owner                             | List / create time off; POST returns overlapping `conflicts`                                                                                                                                                                                                                                              |
| PATCH/DELETE | `/admin/staff/:id/time-off/:timeOffId`                     | self, owner                             | Edit / soft-delete a time-off entry                                                                                                                                                                                                                                                                       |
| GET          | `/admin/clients?search=&sort=&order=&page=&pageSize=`      | staff, owner                            | Paged client directory (name, phone, email search)                                                                                                                                                                                                                                                        |
| GET/PATCH    | `/admin/clients/:id`                                       | staff, owner                            | Profile with appointment history / edit name, phone, notes                                                                                                                                                                                                                                                |
| DELETE       | `/admin/clients/:id`                                       | owner                                   | Soft delete (409 `has_future_appointments` while bookings are upcoming)                                                                                                                                                                                                                                   |
| GET/PATCH    | `/admin/settings`                                          | owner                                   | Salon name, timezone, slot interval, minimum notice, booking window (applies to availability at once)                                                                                                                                                                                                     |
| GET          | `/admin/reports/summary?from=&to=&staffId=`                | owner (all), staff (own numbers)        | Counts by status, revenue, top services, per-day series, per-staff, no-show rate (salon-local dates)                                                                                                                                                                                                      |
| POST         | `/sync/push`                                               | staff, owner                            | Offline sync: ordered, idempotent batch of mutations (per-mutation `applied` / `rejected(reason)` / `retry`)                                                                                                                                                                                              |
| GET          | `/sync/pull?since=&limit=`                                 | staff, owner                            | Sync: change log after a cursor (role filtered, tombstones, paged)                                                                                                                                                                                                                                        |
| GET          | `/sync/stream`                                             | staff, owner                            | Sync: Server-Sent Events nudge ("pull now"), heartbeat, rate limited                                                                                                                                                                                                                                      |

Errors look like `{ "error": { "code", "message" } }` with codes `validation_error` 400, `unauthorized` 401, `forbidden` 403, `not_found` 404, `slot_taken` / `slot_unavailable` / `version_conflict` / `invalid_state` / `has_future_appointments` 409, `rate_limited` 429 (with `Retry-After`) and `internal_error` 500. The exception is `/api/auth/*`, which keeps Better Auth's own error body. The policy matrix is in [ADR 0003](docs/adr/0003-auth-rbac-sessions.md) and the admin extensions in [ADR 0004](docs/adr/0004-admin-api-and-reporting.md).

## Environment variables

| Variable                                                            | Default                                 | Notes                                                                                                                                                                                                             |
| ------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`                                                | none, **required**                      | 32+ characters, `openssl rand -base64 32`. The API exits at startup without it.                                                                                                                                   |
| `BETTER_AUTH_URL`                                                   | `http://localhost:3000`                 | Public base URL of the API. https makes cookies `Secure` (so does `NODE_ENV=production`).                                                                                                                         |
| `TRUSTED_ORIGINS`                                                   | empty                                   | Comma-separated browser origins allowed to call auth with cookies (the web app).                                                                                                                                  |
| `DATABASE_URL`                                                      | `postgres://sob:sob@localhost:5432/sob` | Postgres.                                                                                                                                                                                                         |
| `VALKEY_URL`                                                        | `redis://localhost:6379`                | Sessions (secondary storage) and rate-limit counters.                                                                                                                                                             |
| `VALKEY_KEY_PREFIX`                                                 | `sob:`                                  | Namespace for every Valkey key.                                                                                                                                                                                   |
| `PORT`                                                              | `3000`                                  |                                                                                                                                                                                                                   |
| `TRUST_PROXY`                                                       | `false`                                 | Read the client IP from the last `X-Forwarded-For` entry. Only behind a proxy you operate.                                                                                                                        |
| `RATE_LIMIT_GLOBAL_MAX`, `..._WINDOW_SECONDS`                       | `300`, `60`                             | Per client, every route except `/health`.                                                                                                                                                                         |
| `RATE_LIMIT_AUTH_MAX`, `..._WINDOW_SECONDS`                         | `10`, `60`                              | Per client, sign-in and sign-up.                                                                                                                                                                                  |
| `SYNC_STREAM_RATE_LIMIT_MAX`, `..._WINDOW_SECONDS`                  | `30`, `60`                              | New `/sync/stream` connections per caller.                                                                                                                                                                        |
| `NOTIFY_WORKER_ENABLED`                                             | `false`                                 | Run the reminder worker inside the API process (or use `bun run worker`). See [docs/notifications.md](docs/notifications.md).                                                                                     |
| `NOTIFY_EMAIL_PROVIDER` / `SMTP_URL`                                | `none` / unset                          | `smtp` sends email through `SMTP_URL`; nothing is sent while it is `none`.                                                                                                                                        |
| `NOTIFY_SMS_PROVIDER` / `TWILIO_*`                                  | `none` / unset                          | `twilio` enables SMS (consent required, see the regulatory notes). Other `NOTIFY_*` keys: [docs/notifications.md](docs/notifications.md).                                                                         |
| `MCP_RESOURCE_URL`                                                  | `<BETTER_AUTH_URL>/mcp`                 | Public URL of the MCP endpoint; it is the OAuth resource and token audience.                                                                                                                                      |
| `OAUTH_ACCESS_TOKEN_TTL_SECONDS`, `OAUTH_REFRESH_TOKEN_TTL_SECONDS` | `900`, `1209600`                        | Access (JWT) and refresh token lifetimes.                                                                                                                                                                         |
| `RATE_LIMIT_OAUTH_MAX`, `..._WINDOW_SECONDS`                        | `60`, `60`                              | Per client: authorize, token, consent, revoke, introspect.                                                                                                                                                        |
| `RATE_LIMIT_OAUTH_REGISTER_MAX`, `..._WINDOW_SECONDS`               | `10`, `60`                              | Per client: anonymous dynamic client registration.                                                                                                                                                                |
| `RATE_LIMIT_MCP_MAX`, `..._WINDOW_SECONDS`                          | `120`, `60`                             | Per client: `/mcp` requests.                                                                                                                                                                                      |
| `OWNER_EMAIL`, `OWNER_PASSWORD`, `OWNER_NAME`                       | none                                    | Only read by `bun run bootstrap:owner`; never logged.                                                                                                                                                             |
| `SALON_TIMEZONE`                                                    | `America/Argentina/Buenos_Aires`        | Passed through by Compose.                                                                                                                                                                                        |
| `AUTH_REQUIRE_EMAIL_VERIFICATION`                                   | `true`                                  | Clients confirm their email before signing in. Production refuses to boot with it on and no email provider. `compose.yaml` (development) defaults it to `false`.                                                  |
| `METRICS_TOKEN`                                                     | unset                                   | Bearer token for `/metrics`. Unset: only requests that did not come through the public proxy are answered.                                                                                                        |
| `SHUTDOWN_GRACE_MS`                                                 | `0`                                     | After SIGTERM `/ready` is 503 for this long before the listener closes.                                                                                                                                           |
| `MAINTENANCE_ENABLED`, `MAINTENANCE_INTERVAL_HOURS`                 | `true`, `24`                            | Scheduled housekeeping in the worker. Retention: `SYNC_LOG_RETENTION_DAYS` (30), `REMINDER_RETENTION_DAYS` (90), `DEAD_LETTER_RETENTION_DAYS` (180), `OAUTH_TOKEN_GRACE_DAYS` (7), `OAUTH_IDLE_CLIENT_DAYS` (30). |
| `<NAME>_FILE`                                                       | unset                                   | Read `DATABASE_URL`, `BETTER_AUTH_SECRET`, `SMTP_URL`, `TWILIO_AUTH_TOKEN` or `METRICS_TOKEN` from a file (Docker/Kubernetes secrets).                                                                            |
| `PUBLIC_URL`, `WEB_HSTS` (web server)                               | unset                                   | An https `PUBLIC_URL` (or `WEB_HSTS=true`) makes the web server send HSTS and the CSP add `upgrade-insecure-requests`.                                                                                            |

## MCP server and OAuth 2.1

AI assistants connect to `<origin>/mcp` (Streamable HTTP, stateless) and sign in through the OAuth 2.1 authorization server built into the API (Better Auth `oauthProvider()` + `jwt()`): dynamic client registration, authorization code with mandatory PKCE `S256`, consent screen in the web app (en and es-AR), 15 minute JWT access tokens bound to the MCP resource, rotating refresh tokens, RFC 8414 and RFC 9728 discovery, audit log of grants. Tools (`list_services`, `find_availability`, `create_appointment`, `cancel_appointment`, `list_my_appointments`, and staff-only `list_schedule`, `find_client`) call the same services and policy as REST, so a client token can never see another client's data. Connection guide, scopes and tool catalogue: [docs/mcp.md](docs/mcp.md). Decisions and threat model: [ADR 0009](docs/adr/0009-oauth-and-mcp.md). The desktop client is not on OAuth yet (follow-up listed there).

Tests: `apps/api/src/oauth` (flow, PKCE, refresh rotation, CORS, rate limits, audit), `apps/api/src/mcp` (authorization matrix, booking rules, concurrency, token expiry, and an end-to-end test that runs the official MCP TypeScript SDK client against a live server through discovery, registration, PKCE and tool calls) in a dedicated `sob_test_mcp*` database, and `apps/web/e2e/oauth-consent.spec.ts` for the browser leg.

## Offline sync

The desktop client syncs through three endpoints: `POST /sync/push` (idempotent mutation batches, appointments server-authoritative, everything else last-writer-wins), `GET /sync/pull` (cursor-based change log with tombstones) and `GET /sync/stream` (SSE nudges backed by Valkey pub/sub). The change log is written by deferred Postgres triggers in the same transaction as every write, with `seq` drawn at commit under an advisory lock so a cursor can never skip a change. Decisions: [ADR 0007](docs/adr/0007-sync-protocol.md). Wire spec for client authors (JSON examples, error codes, retry and backoff): [docs/sync-protocol.md](docs/sync-protocol.md). Integration tests run against a dedicated `sob_test_sync` database.

## Desktop client

`apps/desktop` is the offline-first front-desk client: a Rust workspace with a GUI-free core (SQLite replica, outbox, sync engine, SSE nudges with a polling fallback, auth) and a GPUI app (day calendar with a column per staff member, create, move and cancel while offline, pending-sync badges, an online or offline indicator and a conflict review dialog). It signs in with the Better Auth session that the API supports today, behind a trait so the OAuth 2.1 + PKCE flow (server side done in Phase 6, [ADR 0009](docs/adr/0009-oauth-and-mcp.md)) can replace it once `/sync/*` accepts bearer tokens. Build, run and test instructions (including the headless sync tests against the real API): [apps/desktop/README.md](apps/desktop/README.md). Decisions: [ADR 0008](docs/adr/0008-desktop-client.md).

## Web app

`apps/web` is a TanStack Start (SSR) app: the public booking flow (services, professional, date and time, sign in or up inline, confirmation with an .ics download), sign in and sign up, the client account (upcoming and past appointments, optimistic cancel, reschedule, profile) and the staff and owner dashboard under `/admin` (today, calendar with drag and keyboard rescheduling, clients, services, team hours and time off, reports with CSV export, settings), role-based navigation, responsive from 360px. English and Spanish (es-AR), light and dark. Decisions: [ADR 0005](docs/adr/0005-web-app.md) (app, design system) and [ADR 0006](docs/adr/0006-admin-dashboard.md) (dashboard).

The browser only talks to the web origin; the web server proxies `/api/*` to the API (`/api/auth/*` unchanged, `/api/<path>` becomes `/<path>`), so cookies are first-party and there is no CORS.

```sh
bun run --cwd apps/web build
# API in production mode, trusting the web server as its single proxy:
NODE_ENV=production TRUST_PROXY=true TRUSTED_ORIGINS=http://localhost:4173 bun apps/api/src/index.ts &
API_INTERNAL_URL=http://localhost:3000 PORT=4173 bun apps/web/server.ts   # http://localhost:4173, /healthz
```

| Variable (web)     | Default                 | Notes                                                                                       |
| ------------------ | ----------------------- | ------------------------------------------------------------------------------------------- |
| `API_INTERNAL_URL` | `http://localhost:3000` | Where the web server reaches the API (also used for SSR). Read at runtime.                  |
| `PORT`, `HOST`     | `4173`, `0.0.0.0`       |                                                                                             |
| `WEB_TRUST_PROXY`  | `false`                 | Only behind an edge proxy you operate: take the visitor address from its `X-Forwarded-For`. |

### End-to-end tests

The suite books real appointments, so run it against a fresh database (a database saturated by many runs offers no free slots; the admin specs randomize dates to tolerate a few reruns, and the report fixture is a fixed past Tuesday created once). The admin specs also create a staff account (`e2e-staff@example.com`) through the owner API, so `E2E_OWNER_EMAIL` and the owner password (`correct horse battery staple`) must match the bootstrapped owner. Playwright runs against the real stack at a mobile and a desktop viewport (booking flow, slot race, cancel and reschedule, auth errors, i18n, dark mode, axe, keyboard-only). Start Postgres and Valkey, migrate, seed, bootstrap an owner, start the API and the web server as above (raise `RATE_LIMIT_AUTH_MAX` and `RATE_LIMIT_GLOBAL_MAX` for the run), then:

```sh
cd apps/web && bunx playwright install chromium
E2E_OWNER_EMAIL=... E2E_OWNER_PASSWORD=... bun run e2e
```

The e2e suite follows the real confirmation, reset and invitation links, so it needs a mail sink and an API that sends to it: `docker compose --profile mail up -d mailpit`, then start the API with `BETTER_AUTH_URL=http://localhost:4173 NOTIFY_EMAIL_PROVIDER=smtp SMTP_URL=smtp://localhost:1025` (see `.github/workflows/ci.yml` for the full command lines). The owner is bootstrapped with `OWNER_PASSWORD="correct horse battery staple"`, which the helpers use; `E2E_MAILPIT_URL` overrides the inbox API (default `http://localhost:8025`).

### Account security, observability and operations

Email verification, password reset (rate limited, no user enumeration) and staff invitations are on by default; `/health`, `/ready` and `/metrics`, JSON logs with request ids, security headers and a nonce-based CSP are built in. Load tests live in [k6/](k6/README.md), with measured results in [docs/performance.md](docs/performance.md). Backups, upgrades, rollback, secrets rotation and housekeeping are in [docs/operations.md](docs/operations.md); the decisions are in [ADR 0011](docs/adr/0011-production-hardening.md).

### Notifications and reminders

Confirmation, reminder (24 h and 2 h by default, owner-configurable), reschedule and cancellation messages by email and optionally SMS, in English or Spanish (es-AR) with the time in the salon timezone, an `.ics` entry on confirmations, and a login-free unsubscribe link on reminders. Scheduling is written in the same transaction as the appointment change (REST, desktop sync, MCP); a Postgres-backed worker (`SKIP LOCKED` claims, retries with backoff, dead letter, graceful shutdown) delivers them. Off by default: nothing is sent until you set a provider and enable the worker. Local mail catcher: `docker compose --profile mail up -d mailpit`. Operator guide and SMS regulatory notes: [docs/notifications.md](docs/notifications.md). Decisions and delivery guarantees: [ADR 0010](docs/adr/0010-notifications-and-reminders.md). Integration tests use `sob_test_notify*` databases and an in-memory fake provider (plus a real local SMTP server for the adapter); no real message is ever sent.

## Docker

```sh
export BETTER_AUTH_SECRET="$(openssl rand -base64 32)"
docker compose up -d --wait postgres valkey
bun run db:migrate                                   # or: docker compose run --rm api bun packages/db/src/scripts/migrate.ts
docker compose up -d --build --wait api web
curl localhost:3000/health     # API (loopback only)
curl localhost:4173/healthz    # web: open http://localhost:4173
```

`BETTER_AUTH_SECRET` is deliberately not marked required in `compose.yaml` (Compose would then demand it even for `up postgres valkey`); the API validates it at startup and exits with a clear error. With `NODE_ENV=production` cookies are `Secure`, so browsers need https: terminate TLS in your proxy and set `BETTER_AUTH_URL` and `TRUST_PROXY=true`.

### Production

`compose.prod.yaml` is the hardened stack (no database ports, read-only containers, resource limits, one-shot migrations, a separate worker, optional automatic HTTPS with Caddy):

```sh
export POSTGRES_PASSWORD="$(openssl rand -base64 24)" BETTER_AUTH_SECRET="$(openssl rand -base64 32)" \
       PUBLIC_URL=https://salon.example SMTP_URL=smtps://user:pass@smtp.example:465
docker compose -f compose.prod.yaml up -d --build --wait
OWNER_EMAIL=you@salon.example OWNER_PASSWORD='a long passphrase' \
  docker compose -f compose.prod.yaml --profile setup run --rm bootstrap-owner
SITE_ADDRESS=salon.example docker compose -f compose.prod.yaml --profile tls up -d   # optional HTTPS
```

See [docs/operations.md](docs/operations.md).

## Common commands

```sh
bun run typecheck   # tsc across workspaces (via Turborepo)
bun run lint        # Biome
bun run test        # bun test; integration tests need the compose postgres and valkey
bun run db:generate # drizzle-kit: generate a migration from schema changes
bun run bootstrap:owner   # idempotent first owner from OWNER_EMAIL / OWNER_PASSWORD
bun run maintenance       # one-shot housekeeping (the worker also runs it daily)
bun run backup            # pg_dump to backups/ with a checksum (scripts/restore.sh restores it)
bun run test:scripts      # backup/restore round trip against compose Postgres
bun run k6:availability   # also k6:contention, k6:mixed (see k6/README.md)
docker compose up -d --build   # full stack (postgres, valkey, api, web)
```

Integration tests create their own `sob_test_*` databases on the server in `DATABASE_URL` and use unique `sob-test:*` key prefixes on the Valkey in `VALKEY_URL`. Both fail loudly, with a hint, if the service is unreachable.

## Layout

- `apps/api`: Hono API on Bun (`src/modules/*`: services, staff, availability, appointments, clients, reports, admin, me; `src/auth`: Better Auth, principal, policy, accounts)
- `apps/web`: TanStack Start web app (`src/routes`, `src/features/{booking,account,auth,admin}`, `src/components/ui`, `src/i18n`, `src/server` BFF proxy and web server, `e2e`)
- `apps/desktop`: Rust workspace, not part of the Bun workspaces or Turborepo (`crates/core` store, outbox, sync, auth; `crates/app` GPUI shell)
- `packages/contracts`: shared Zod schemas and the error shape
- `packages/db`: Drizzle schema (domain, Better Auth tables, audit log), migrations (including the hand-written exclusion constraint), seed
- `packages/config`: shared TypeScript config
