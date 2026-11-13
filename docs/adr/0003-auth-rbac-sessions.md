# ADR 0003: Authentication, roles, sessions, rate limiting and audit

Status: accepted (Phase 2)

## Context

Phase 1 left every route open. Phase 2 adds identity, authorization, abuse protection and an audit trail. The same Better Auth instance must later act as the OAuth 2.1 authorization server for the MCP server and the desktop client (Phase 6), so nothing here may paint that into a corner.

## Decisions

### Better Auth 1.7.23, email + password

- Pinned exactly (`better-auth@1.7.23`, the npm `latest` at implementation time). Mounted in Hono at `/api/auth/*` (`app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw))`).
- Drizzle adapter on the existing Postgres. The four core tables (`user`, `session`, `account`, `verification`) were generated with `bunx auth generate --adapter drizzle` and then adapted to this repo's conventions (snake_case, `timestamptz`, explicit constraint names). They ship as a normal, committed migration (`0002_auth_rbac_audit.sql`); applied migrations are never edited.
- Ids are `text` (Better Auth owns them) filled with UUIDv7 through `advanced.database.generateId`.
- **Phase 6 readiness.** The `oauthProvider()` / `mcp()` plugins are intentionally not installed: the docs disagree between versions and Phase 6 must read the docs for the then-installed version and use only one of them. The configuration is plugin-ready: one `betterAuth()` instance created by `createAuth()`, shared Drizzle adapter, shared Valkey secondary storage, shared secret, stable string ids. Adding a plugin means adding its tables through a new migration and one line in `createAuth()`.
- Out of scope for v1 and documented as gaps: email verification, password reset (both need the Phase 7 email adapter), MFA. Passwords are hashed by Better Auth (scrypt); length 8-128.
- `/api/auth/*` keeps Better Auth's own error body. Everything else uses the `{ error: { code, message } }` envelope.

### Sessions in Valkey (secondary storage)

Better Auth's `secondaryStorage` is implemented over Bun's built-in Redis client against Valkey (`src/auth/secondary-storage.ts`; `get`, `set` with TTL, `delete`, `getAndDelete`, atomic `increment`). Every key is prefixed with `VALKEY_KEY_PREFIX` (default `sob:`), which also isolates test runs.

Why Valkey and not Postgres:

- Session lookup happens on every authenticated request; a key lookup with a native TTL is cheaper than a relational read plus an expiry sweep, and it keeps the hot path off the database that must stay free for booking transactions.
- Revocation is a `DEL`; expiry needs no cleanup job.
- The API can scale horizontally with no sticky sessions, and Valkey is already in the stack for rate limiting, pub/sub and the reminder queue.

Trade-offs, accepted:

- With secondary storage Better Auth does not persist sessions in Postgres (the `session` table exists but stays empty). Losing Valkey data logs everybody out; nothing else is lost. Compose mounts a volume so a restart keeps sessions.
- A cached session payload can be stale. Therefore **the role is never read from the session**: `requireAuth` resolves the principal from the database on every request (user row plus staff and client profile ids). A role change, a demotion or a deleted user takes effect immediately. The cost is two small indexed reads per authenticated request.

### Cookies and CSRF

- `HttpOnly`, `SameSite=Lax`, and `Secure` whenever `BETTER_AUTH_URL` is https or `NODE_ENV=production`.
- Better Auth's origin check is switched on explicitly (`disableOriginCheck: false`, `disableCSRFCheck: false`) because Better Auth disables both under `NODE_ENV=test`. It validates `Origin` against `BETTER_AUTH_URL` plus `TRUSTED_ORIGINS` for requests that carry cookies; a cookie-authenticated mutation from another origin is a 403.
- `TRUSTED_ORIGINS` is a comma-separated env list (the web app's origin).

### Roles

Exactly one role per account: `owner`, `staff`, `client` (`user.role`, CHECK-constrained, default `client`).

- **Sign-up is always a client.** `role` is an `additionalField` with `input: false`, so it cannot be supplied through sign-up or profile updates. The `user.create.after` hook creates the linked `client_profile`; the principal loader repairs a missing profile lazily if that hook ever fails.
- **Profiles link to accounts with real foreign keys** (`staff_profile.user_id`, `client_profile.user_id`, both unique, `ON DELETE SET NULL`). A client profile is not auto-linked by email to a pre-existing walk-in profile: the email is unverified, so linking would let someone read another person's history by registering their address.
- **Only an owner creates staff** (`POST /admin/staff-accounts`, atomic: user, credential account, calendar profile) **and assigns roles** (`PATCH /admin/users/:id/role`). Promoting to staff creates or reactivates the calendar profile; demoting to client deactivates it (`active = false`) so it cannot be booked, without deleting history. An owner cannot change their own role (no accidental lock-out).
- **First owner:** `bun run bootstrap:owner` reads `OWNER_EMAIL`, `OWNER_PASSWORD` (and optional `OWNER_NAME`) from the environment, never logs the password, and is idempotent. If the email already belongs to a non-owner account it refuses to promote it: someone could have pre-registered that address through public sign-up and would otherwise inherit the owner role together with their own password.

### Authorization policy

Implemented as pure functions (`src/auth/policy.ts`) over a `Principal`, with no HTTP or database knowledge, so the MCP tools in Phase 6 enforce the same rules. Anything not listed is forbidden.

| Resource / action                                     | Anonymous | Client              | Staff                                                       | Owner          |
| ----------------------------------------------------- | --------- | ------------------- | ----------------------------------------------------------- | -------------- |
| `GET /health`                                         | yes       | yes                 | yes                                                         | yes            |
| `GET /services`, `/staff`, `/availability`            | yes       | yes                 | yes                                                         | yes            |
| `GET /me`                                             | 401       | yes                 | yes                                                         | yes            |
| `POST /appointments`                                  | **401**   | for themselves only | into their own calendar                                     | any            |
| `GET /appointments`                                   | 401       | only their own      | only their own calendar                                     | all            |
| `PATCH /appointments/:id` (reschedule, cancel, notes) | 401       | only their own      | only on their own calendar, cannot move to another calendar | any            |
| `POST /admin/staff-accounts`                          | 401       | 403                 | 403                                                         | yes            |
| `PATCH /admin/users/:id/role`                         | 401       | 403                 | 403                                                         | yes (not self) |

Details worth knowing:

- A client's booking payload carries no client identity (`createAppointmentBaseSchema`); the server pins their own profile. A foreign `clientId` is a 403, an inline `client` payload is dropped. Staff and owners must still name the client (`createAppointmentRequestSchema`).
- An unknown appointment id is a 404 for everyone, evaluated before ownership, so a 403 never reveals that an id exists belonging to someone else.
- **Guest booking is out of scope for v1.** Anonymous `POST /appointments` returns `401 unauthorized`. Allowing it would need email/phone verification to stop slot hoarding and impersonation, which depends on the Phase 7 notification channel. The front desk covers walk-ins and phone bookings through staff accounts.

### Rate limiting

Fixed-window counters in Valkey (`src/rate-limit.ts`). Key: `rl:<scope>:<client>:<windowIndex>`, where the window index is `floor(now / window)` from an injectable clock. Each request runs one Lua script (`INCR`, then `EXPIRE` only if the key has no TTL), so it is atomic under concurrency and one round trip, and the TTL only garbage-collects old windows.

- Scopes: `global` (every route except `/health`, default 300 per 60 s) and `auth` (`/api/auth/sign-in/*` and `/api/auth/sign-up/*`, default 10 per 60 s). Both are configurable (`RATE_LIMIT_*`).
- Over the limit: `429` with `{ error: { code: "rate_limited" } }` and `Retry-After` (seconds left in the window).
- Fixed windows allow up to 2x the limit across a window boundary. For brute-force and abuse protection that is acceptable and much simpler than a sliding window; the algorithm is isolated in `createRateLimiter`, so it can be swapped.
- Client identity: the socket address, or with `TRUST_PROXY=true` the **last** `X-Forwarded-For` entry (the address the single trusted proxy saw). `X-Forwarded-For` is attacker-controlled otherwise, so it is ignored by default. Better Auth's own limiter is disabled to avoid double counting.
- Valkey errors propagate as `500` (fail closed): the sessions need Valkey anyway, and a silent fail-open would disable brute-force protection exactly when something is wrong.

### Audit log

`audit_log` (`id` UUIDv7, `actor_user_id` nullable with `ON DELETE SET NULL`, `action`, `entity`, `entity_id`, `metadata jsonb`, `created_at`). `recordAudit()` takes a database handle or a transaction and is called inside the same transaction as the change, so there is never a change without its record or the reverse. Recorded: `appointment.create|reschedule|cancel|update`, `staff.create`, `user.role_change`, `owner.bootstrap`. Rejected attempts (403, 409, 401) write nothing. `redactMetadata()` strips any key that looks like a credential (password, token, secret, cookie, authorization, hash) at any depth as a safety net; callers pass only ids and changed fields anyway.

## Consequences

- Phase 1 tests now run as the owner; new tests cover each policy cell, including negative cases, against real Postgres and Valkey.
- Anything that stores sessions or counters needs Valkey: the API refuses to start without it, and tests fail with an explicit message when it is unreachable.
- `compose.yaml` no longer uses `:?` for `BETTER_AUTH_SECRET` (Compose resolves it for every service and blocked `up postgres valkey`); the API validates the variable at startup and exits with a clear error instead.
- Known gaps tracked for later phases: email verification and password reset (Phase 7), account lockout beyond rate limiting, MFA, session listing and revocation endpoints, OAuth 2.1 (Phase 6).
