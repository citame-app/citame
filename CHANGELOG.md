# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/) (pre-1.0: minor versions may contain breaking changes, called out below).

## [Unreleased]

### Fixed

- **Web**: a page whose server-side API calls are rate limited is now answered with `429` and `Retry-After` and a notice in the visitor's language (English or es-AR), instead of a `500`. A signed-in visitor who hits the limit is no longer rendered or redirected as signed out.

## [0.1.0] - 2026-11-14

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

### Known limitations

See "Known limitations and roadmap" in [docs/PLAN.md](docs/PLAN.md): no MFA, account emails are not on a durable queue, no OpenTelemetry tracing, single location, no online payments, the desktop client signs in with a session (OAuth loopback login is a documented follow-up) and has UI gaps, sync tombstones are never purged.

[Unreleased]: https://github.com/OWNER/REPO/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/OWNER/REPO/releases/tag/v0.1.0
