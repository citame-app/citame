# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/) (pre-1.0: minor versions may contain breaking changes, called out below).

## [Unreleased]

### Added

- Single-location checkout, cash sessions, receipt/refund reconciliation, retail stock and staff commissions; configurable deposits and a hosted Redsys card/Bizum adapter, with optional explicitly consented membership renewal.
- Gift cards, prepaid plans, memberships, loyalty points and bounded promotion codes. Customer booking reviews bind the offer, discounted total and deposit; uncertain requests recover their original visit.
- Recurring appointment series, held waitlist offers, shared room/equipment capacity, service variants/extras/combinations, date-specific shifts, treatment processing intervals and explicitly configured concurrent professional work.
- Client controls/tags, reviewed CSV transfer, private photos and versioned intake forms; completed-visit reviews, moderated public portfolio, booking links/QR/widget and separately consented local social creative.
- Scoped staff access and English/Spanish operational interfaces, with regression coverage for mobile/desktop, light/dark, accessibility and uncertain-response recovery.

### Changed

- Scheduling protects frozen active-work intervals independently from a visit's full client span. Rooms and equipment remain occupied during processing; legacy visits keep continuous blocking.
- Offline desktop proposals retain reviewed catalog terms and timing across sync. Changed terms require a new proposal; rescheduling cannot silently accept them.

### Delivery status

- This expansion remains in development. [The delivery checklist](docs/FEATURE-EXPANSION.md) tracks unfinished CRM, marketing, mobile and additional single-business features. Vendor credentials, a production domain and verified salon content remain external activation steps; no deployment or bank activation is implied.

## [0.1.0] - 2026-11-15

First release: a self-hostable booking and salon-management platform for one salon.

### Added

- **Booking core** (API, Postgres): services, staff, weekly working hours, time off, availability search with DST-safe computation, buffers and minimum notice, appointments with versioned reschedule, cancel and status transitions. A Postgres exclusion constraint (`btree_gist`) is the source of truth against double booking; conflicts surface as `409 slot_taken`.
- **Auth and RBAC**: Better Auth (email and password, Valkey-backed sessions), roles `owner`, `staff` and `client`, a policy matrix, audit log, global and strict rate limits, owner bootstrap command.
- **Account security**: email verification, password reset and staff invitations without user enumeration, per-address email throttle, CSRF origin checks, security headers and a nonce-based CSP.
- **Web app** (TanStack Start, English and Spanish es-AR, light and dark, responsive from 360 px): public booking flow, client account (appointments, reschedule, cancel, profile, notification preferences), staff and owner dashboard (today, drag-and-keyboard calendar, clients, services, team hours and time off, reports with CSV export, settings), consent screen and unsubscribe page.
- **Offline sync**: `POST /sync/push` (idempotent), `GET /sync/pull` (cursor, tombstones) and `GET /sync/stream` (SSE), with a change log written by deferred Postgres triggers.
- **Desktop client** (Rust, GPUI): offline-first front-desk calendar over a SQLite replica and outbox, sync engine, conflict review. Linux is the supported target.
- **OAuth 2.1 and MCP**: authorization server with PKCE and dynamic client registration, consent screen, and an MCP server (Streamable HTTP) with client and staff tools that reuse the REST service layer.
- **Notifications**: confirmation, reminder (24 h and 2 h by default), reschedule and cancellation messages by email and optional SMS (Twilio), Postgres-backed worker with retries and dead letter, `.ics` attachments, one-click unsubscribe.
- **Operations**: `/health`, `/ready`, Prometheus `/metrics`, JSON logs with request ids, graceful shutdown, scheduled housekeeping, backup and restore scripts, hardened `compose.prod.yaml` with optional Caddy HTTPS, k6 load and contention scenarios with measured results, a production smoke script.
- **Open-source files**: LICENSE (MIT), CONTRIBUTING, SECURITY, Code of Conduct, issue and pull request templates, Dependabot configuration, self-hosting guide, environment reference, security review and dependency inventory, a tag-driven release workflow.

### Release-readiness additions

- **Durable account mail**: encrypted Postgres outbox with persistent throttling, retries, expiring links, lease renewal, dead letters, retention and queue metrics; requests await storage instead of SMTP.
- **Desktop**: day/week views, staff selection, completed/no-show offline actions, native text selection/clipboard/IME, persisted light/dark theme.
- **Release**: local version/changelog/tag validation, source metadata, reproducible Linux archives and checksums; publication requires the full CI suite and successful desktop packaging on the requested tag.
- **Dependencies**: pin transitive esbuild to 0.28.2; production and complete JavaScript audits report no vulnerabilities.

### Fixed

- **Operations**: isolate production smoke runs with unique Compose projects and image tags, ignore deployment `.env` files, disable inherited SMS providers, clean up temporary credentials, and allow realistic backup/restore integration-test durations.
- **Tooling**: preserve runtime configuration in `bun run dev` and custom service settings in the root E2E task; exclude Rust build outputs, browser traces, screenshots and backups from Docker contexts; remove unused timezone configuration and lint warnings.
- **Tests**: give each accessibility-audit appointment its own client identity so light and dark audits remain unambiguous even when they book on the same day; apply the API integration-test timeout through the test command.
- **Desktop dates**: open on today in the salon timezone, including the first synced catalog; preserve an explicitly chosen day.
- **Web**: a page whose server-side API calls are rate limited is now answered with `429` and `Retry-After` and a notice in the visitor's language (English or es-AR), instead of a `500`. A signed-in visitor who hits the limit is no longer rendered or redirected as signed out.

### Added

- **Deployment**: a production `.env.example` with required secrets left blank and documented generation commands.

### Known limitations

See "Known limitations and roadmap" in [docs/PLAN.md](docs/PLAN.md): no MFA, no OpenTelemetry tracing, single location, no online payments, the desktop client signs in with a session (OAuth loopback login is a documented follow-up) and uses a Linux archive rather than a system installer, sync tombstones are never purged.
