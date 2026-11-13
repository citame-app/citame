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
bun run dev                           # API on http://localhost:3000
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

| Method   | Path                                                    | Access                                  | Purpose                                                                  |
| -------- | ------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------ |
| GET      | `/health`                                               | public                                  | Liveness                                                                 |
| GET      | `/services`                                             | public                                  | Active service catalog                                                   |
| GET      | `/staff`                                                | public                                  | Active staff and the services they perform                               |
| GET      | `/availability?serviceIds=a,b&staffId=&date=YYYY-MM-DD` | public                                  | Bookable slots (`staffId` optional)                                      |
| GET/POST | `/api/auth/*`                                           | public, strictly rate limited           | Better Auth: sign-up, sign-in, sign-out, session                         |
| GET      | `/me`                                                   | signed in                               | Role and linked profile ids                                              |
| POST     | `/appointments`                                         | client, staff, owner                    | Book (409 `slot_taken` on overlap); clients book for themselves only     |
| PATCH    | `/appointments/:id`                                     | the client, the calendar's staff, owner | Reschedule or cancel with the current `version` (409 `version_conflict`) |
| GET      | `/appointments?from=&to=&staffId=`                      | signed in                               | Role-filtered: clients see theirs, staff their calendar, owner all       |
| POST     | `/admin/staff-accounts`                                 | owner                                   | Create a staff login and calendar                                        |
| PATCH    | `/admin/users/:id/role`                                 | owner                                   | Change a role (`owner`, `staff`, `client`); not your own                 |

Errors look like `{ "error": { "code", "message" } }` with codes `validation_error` 400, `unauthorized` 401, `forbidden` 403, `not_found` 404, `slot_taken` / `version_conflict` / `invalid_state` 409, `rate_limited` 429 (with `Retry-After`) and `internal_error` 500. The exception is `/api/auth/*`, which keeps Better Auth's own error body. The full policy matrix is in [ADR 0003](docs/adr/0003-auth-rbac-sessions.md).

## Environment variables

| Variable                                      | Default                                 | Notes                                                                                      |
| --------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------ |
| `BETTER_AUTH_SECRET`                          | none, **required**                      | 32+ characters, `openssl rand -base64 32`. The API exits at startup without it.            |
| `BETTER_AUTH_URL`                             | `http://localhost:3000`                 | Public base URL of the API. https makes cookies `Secure` (so does `NODE_ENV=production`).  |
| `TRUSTED_ORIGINS`                             | empty                                   | Comma-separated browser origins allowed to call auth with cookies (the web app).           |
| `DATABASE_URL`                                | `postgres://sob:sob@localhost:5432/sob` | Postgres.                                                                                  |
| `VALKEY_URL`                                  | `redis://localhost:6379`                | Sessions (secondary storage) and rate-limit counters.                                      |
| `VALKEY_KEY_PREFIX`                           | `sob:`                                  | Namespace for every Valkey key.                                                            |
| `PORT`                                        | `3000`                                  |                                                                                            |
| `TRUST_PROXY`                                 | `false`                                 | Read the client IP from the last `X-Forwarded-For` entry. Only behind a proxy you operate. |
| `RATE_LIMIT_GLOBAL_MAX`, `..._WINDOW_SECONDS` | `300`, `60`                             | Per client, every route except `/health`.                                                  |
| `RATE_LIMIT_AUTH_MAX`, `..._WINDOW_SECONDS`   | `10`, `60`                              | Per client, sign-in and sign-up.                                                           |
| `OWNER_EMAIL`, `OWNER_PASSWORD`, `OWNER_NAME` | none                                    | Only read by `bun run bootstrap:owner`; never logged.                                      |
| `SALON_TIMEZONE`                              | `America/Argentina/Buenos_Aires`        | Passed through by Compose.                                                                 |

## Docker

```sh
export BETTER_AUTH_SECRET="$(openssl rand -base64 32)"
docker compose up -d --wait postgres valkey
bun run db:migrate                                   # or: docker compose run --rm api bun packages/db/src/scripts/migrate.ts
docker compose up -d --build --wait api
curl localhost:3000/health
```

`BETTER_AUTH_SECRET` is deliberately not marked required in `compose.yaml` (Compose would then demand it even for `up postgres valkey`); the API validates it at startup and exits with a clear error. With `NODE_ENV=production` cookies are `Secure`, so browsers need https: terminate TLS in your proxy and set `BETTER_AUTH_URL` and `TRUST_PROXY=true`.

## Common commands

```sh
bun run typecheck   # tsc across workspaces (via Turborepo)
bun run lint        # Biome
bun run test        # bun test; integration tests need the compose postgres and valkey
bun run db:generate # drizzle-kit: generate a migration from schema changes
bun run bootstrap:owner   # idempotent first owner from OWNER_EMAIL / OWNER_PASSWORD
docker compose up -d --build   # full stack (postgres, valkey, api)
```

Integration tests create their own `sob_test_*` databases on the server in `DATABASE_URL` and use unique `sob-test:*` key prefixes on the Valkey in `VALKEY_URL`. Both fail loudly, with a hint, if the service is unreachable.

## Layout

- `apps/api`: Hono API on Bun (`src/modules/*`: services, staff, availability, appointments, admin, me; `src/auth`: Better Auth, principal, policy, accounts)
- `packages/contracts`: shared Zod schemas and the error shape
- `packages/db`: Drizzle schema (domain, Better Auth tables, audit log), migrations (including the hand-written exclusion constraint), seed
- `packages/config`: shared TypeScript config
