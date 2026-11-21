# ADR 0011: Production hardening (account security, observability, operations)

Status: accepted (Phase 8a)

## Context

Phases 0 to 7 produced a working product with known gaps: ADR 0003 listed email verification and password reset as missing, there were no metrics or readiness probe, no load evidence, no backup procedure and no production compose file. This ADR records the decisions that close them.

## Decisions

### Email verification and password reset use Better Auth's own flows

Better Auth 1.7.23 already implements both; we configure instead of building.

- `emailAndPassword.requireEmailVerification` (env `AUTH_REQUIRE_EMAIL_VERIFICATION`, default **true**): a client gets no session until the emailed link is followed, so booking (which needs a session) requires a confirmed address. `emailVerification.autoSignInAfterVerification` makes the link also sign the person in and return them to where they were (`/verify-email?next=...`, the booking review step keeps its selection in the URL). `sendOnSignIn` sends a fresh link to an unconfirmed person who tries to sign in.
- **No user enumeration.** With verification required, Better Auth answers a duplicate sign-up like a fresh one; we add an `account_exists` email to the real owner of the address ("you already have an account, reset your password here"). `request-password-reset` and `send-verification-email` answer identically for known and unknown addresses (asserted by tests). Sign-in only reveals "not confirmed" after a correct password.
- Reset links live 1 hour, are single-use, and `revokeSessionsOnPasswordReset` ends every existing session. Following a reset link also marks the address verified (it proves mailbox control).
- Rate limits: the strict `auth` budget, counted in its own `auth-email` scope, covers `request-password-reset`, `reset-password`, `send-verification-email` and `verify-email`. On top of that each (kind, address) pair gets at most one email per 60 s (a Postgres transaction/advisory lock keyed by a hash of the kind and address) so the endpoints cannot be used to mail-bomb a person.
- Production refuses to boot with verification required but no email provider (`NOTIFY_EMAIL_PROVIDER=none`): every client would be locked out. Opting out is explicit (`AUTH_REQUIRE_EMAIL_VERIFICATION=false`).
- Owners and staff are trusted accounts: bootstrap and owner-created accounts are verified from the start; migration `0007` marks the existing ones verified so nobody is locked out by the upgrade. Existing clients confirm on their next sign-in.

### Account emails use a separate durable, encrypted outbox

Revised 2026-11-15: verification, reset, existing-account and invitation messages are committed to `account_email_outbox` before the HTTP request completes. SMTP runs in the background, keeping provider latency out of the response. A failed enqueue fails the request instead of acknowledging a volatile send. The queue is separate from appointment reminders because account messages have expiring action links and no appointment id.

The entire rendered message is encrypted using AES-256-GCM with a domain-separated key derived from `BETTER_AUTH_SECRET`, a random nonce and the row id as authenticated data. Idempotency and mailbox throttle keys are hashed. Terminal rows have their payload erased; neither provider exceptions nor addresses/action links are persisted as error messages.

The API polls whenever an email provider is configured; the standalone notification worker can also drain the queue. `SKIP LOCKED`, renewable visibility leases and fenced updates allow multiple processes. Delivery is at least once: SMTP acceptance followed by a crash before acknowledgement can duplicate a message. The stable message idempotency key helps a supporting provider deduplicate; it cannot make SMTP exactly once. Retries use the existing notification backoff/attempt settings, expired links are skipped, and shutdown waits for active work. Pending encrypted rows survive a restart; terminal retention uses the existing reminder/dead-letter windows. Rotating the secret makes queued payloads unreadable: drain first when possible, or let people request fresh links after rotation.

Language still comes from `sob_locale`, then `Accept-Language`, then `NOTIFY_DEFAULT_LOCALE`. Templates remain in `notifications/auth-emails.ts` (English and es-AR).

### Staff invitations reuse the reset-token mechanism

`POST /admin/staff-accounts` without `password` creates the account with an unknowable random credential, stores a reset token valid for 72 hours and emails the invitation. The invitee lands on the normal reset page (`?invited=1` only changes the copy), chooses a password, which also verifies the address. The owner never sees or relays a credential. Giving a password still works (the owner vouches for the address).

### Security headers and CSRF

- API: `nosniff`, `Referrer-Policy: no-referrer`, a CSP that forbids everything (it only serves JSON), `X-Frame-Options: DENY`, a restrictive `Permissions-Policy`, and HSTS when the deployment is https.
- Authenticated appointment routes, archive consultation routes and replica pulls set `Cache-Control: private, no-store` because the representation depends on the caller and can contain client or appointment data.
- Web: the same baseline from the web server (HSTS when `PUBLIC_URL` is https or `WEB_HSTS=true`) and a **per-request nonce CSP** for pages. TanStack Start streams inline bootstrap scripts, so `script-src 'self' 'nonce-...'` (never `unsafe-inline`); the nonce is generated by `ssr.nonce` in the router and the root route's `headers` callback emits the policy. `style-src-attr 'unsafe-inline'` is allowed (React inline styles, charts) because attributes cannot execute code. Everything else is `'self'`, `frame-ancestors 'none'`.
- CSRF: cookies are `HttpOnly`, `SameSite=Lax`, `Secure` and `__Secure-` prefixed in production (asserted by a test with production config). Better Auth keeps its own origin check for `/api/auth/*`; we added a check for our own cookie-authenticated mutations (`/appointments`, `/me`, `/admin`, `/sync`): a request that carries an `Origin` not in `BETTER_AUTH_URL` + `TRUSTED_ORIGINS` is a 403. Requests without `Origin` (the desktop client, curl) are not browsers and are unaffected. The public OAuth/MCP endpoints are cross-origin by design and untouched.

### Observability

- **Logs**: one JSON object per line on stdout (`time`, `level`, `msg`, `requestId`, ...). A redactor removes values by key name (password, token, secret, cookie, authorization, email, phone, ...) and scrubs email addresses, URL credentials and bearer/JWT strings inside any string. Access logs record the route pattern and the path **without the query string** (reset and opt-out tokens travel there) and never the client address. Better Auth's own console output is routed through the same logger.
- **Request ids**: the web server assigns `X-Request-Id` (or keeps a well-formed inbound one from an edge proxy), passes it to SSR server functions and to the API proxy; the API puts it in an `AsyncLocalStorage` so every log line of the request carries it, and echoes it in the response.
- **Probes**: `/health` is liveness (never touches a dependency, so an outage does not restart-loop the container); `/ready` checks Postgres and Valkey with a timeout and returns 503 while draining or when either fails (the body names the failing dependency, never the error). Neither is rate limited or access-logged.
- **Metrics**: `/metrics` in the Prometheus text format, from a small in-house registry (no dependency): HTTP requests and latency histogram by route pattern, booking outcomes (`created`, `slot_taken`, `rejected`) per entry point, sync push mutations by status/reason and pull requests/changes, the notification worker counters, `sob_db_up`, `sob_db_connections` (from `pg_stat_activity`), `sob_valkey_up` and process gauges. Bun's SQL client exposes no live pool counters, so only the configured pool size is reported. Access: with `METRICS_TOKEN` a bearer token is required; without it only requests that did **not** come through the public proxy are answered (the proxy always adds `X-Forwarded-*`), and the web proxy and the Caddyfile additionally never route `/api/metrics`.
- **Graceful shutdown**: on SIGTERM `/ready` turns 503 (`draining`), the process waits `SHUTDOWN_GRACE_MS`, stops accepting connections and lets in-flight requests finish, ends SSE streams, stops the worker after its current job, then closes Postgres and Valkey and exits 0. Verified by a test that runs the real entrypoint and signals it.

### Scheduled housekeeping

`runMaintenance` (run by the worker daily, or `bun run maintenance` from cron) removes: superseded `sync_change` rows older than 30 days (tombstones stay, ADR 0007), sent/skipped/cancelled reminders older than 90 days and dead letters older than 180, OAuth tokens expired more than 7 days ago, dynamically registered OAuth clients idle for 30 days (no token, no consent; the first-party desktop client is exempt), expired verification values and sessions. A transaction-scoped advisory lock lets any number of workers run it safely. All windows are env-tunable.

### Production compose

`compose.prod.yaml`: only `web` is published (loopback by default); Postgres and Valkey are internal; migrations run in a one-shot `migrate` service the API and worker wait for; the worker is its own service; every container drops capabilities, has a read-only root filesystem, `no-new-privileges`, resource limits, restart policy and healthchecks; Caddy with automatic HTTPS is an opt-in `tls` profile. Secrets are env variables, and `*_FILE` variants (Docker/Kubernetes secrets) are supported for the API.

## Consequences

- Fresh deployments need a mail provider (or an explicit opt-out). Local development without mail sets `AUTH_REQUIRE_EMAIL_VERIFICATION=false` or runs Mailpit (`--profile mail`).
- Multi-process deployments keep working: the metrics are per process (scrape every replica), rate limits live in Valkey and account-mail throttling is durable in Postgres.
- Not done, tracked: MFA, account lockout beyond rate limiting, OpenTelemetry tracing.
