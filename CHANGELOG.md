# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/) (pre-1.0: minor versions may contain breaking changes, called out below).

## [Unreleased]

Reviewed client identity links now join duplicate salon profiles while preserving original history, balances, expiry dates and permissions. The EN/ES review supports uncertain-request recovery; search, CSV review, private history and offline pickers recognize surviving identities. [Operation and limits](docs/client-merging.md).

### Added

- Compare delivery totals for up to four campaigns or booking invitations in Cloud Web and Desktop. The selection persists between pages.

- Web and Desktop can issue gift cards for selected treatments and show the terms on vouchers and when checking balances. Checkout verifies the eligible amount even for mixed payments.

- Web and Desktop can issue gift cards at a sale price distinct from their initial balance. The receipt records the reviewed price and purchase refunds revoke the proportional gift value.

- Desktop prepares Redsys card and Bizum payments for the reviewed amount. The linked browser opens the exact receipt and can continue the same pending bank order after reloading. Citame updates the receipt when the bank confirms payment.

- Desktop can search and browse the saved gift register offline. The register shows when balances were saved, retains previously opened movement pages, and clears the saved data when account visibility changes.

- Web and Desktop show confirmed payments and the remaining receipt balance directly in To collect. Existing receipts reopen by ID and display unresolved payment or price review states.

- Desktop can browse previously loaded active and history waitlist pages offline. Offer actions continue to use the current server state.

- Desktop shows live notices when an appointment is moved or cancelled from another client, alongside the existing new-booking notices.

- Cloud and Desktop group appointment outcomes by the promotion reviewed at booking, with the same filters and CSV export as the appointment report.

- Publish dated service promotions as flash offers from Cloud Web and Desktop. Clients see published offers on the public profile and review the applicable discount before confirming a booking.

- The Booksy recovery verifier checks trusted operational copy and bidirectional write receipts against the selected snapshot, encrypted backup, rehearsal date and full release migration ledger.
- The isolated Booksy restore rehearsal verifies Web-to-Desktop and Desktop-to-Web appointment moves, live updates, retry idempotency and stale-version rejection while preserving appointment details, resource assignments and existing mutation receipts. [Migration protocol](docs/booksy-import-protocol.md#ensayar-la-separación-de-la-base-operativa)

- Desktop receipts support final service prices, walk-in checkout, transaction history with date, tender and status filters, sale attribution, customer discounts, gift card redemption, eligible prepaid service redemptions and returns, and refunds for cash, external-card, and gift card payments. Voiding an unpaid receipt releases its reserved stock. Desktop records physical product returns from fulfilled receipts. Desktop preserves unconfirmed requests across restarts, and Cloud preserves them across reloads in the same tab.
- Desktop prints the reviewed receipt in a temporary browser preview, including when the open receipt is offline.
- Desktop issues and manages gift cards from the cash desk. Purchases can reopen the same receipt after an interrupted request. Web and Desktop refresh gift cards after balance and code changes. Desktop prints vouchers in a one-use local preview.
- The Desktop management menu opens permitted Cloud areas in the browser with the linked account.
- Desktop edits existing service prices, timing, presentation and booking availability with the same catalogue permissions as Cloud. A stale draft must be reviewed before publishing.
- The Desktop service editor saves service details and performer assignments together, including when the draft was edited offline.
- Desktop edits variant labels and compatible services for add-ons in the same reviewed save.
- Desktop configures required rooms and equipment per service, including alternatives and offline edits with conflict review.
- Desktop creates and edits rooms, equipment and stations with offline drafts and Cloud's future-reservation checks.
- Desktop creates, reorders, updates and archives treatment combinations. Offline drafts retain the reviewed version and can be reconciled with changes from Cloud.
- Desktop filters and sorts the product catalogue with the same options as Cloud, shows filtered stock totals and exports all matching products. Costs remain restricted to authorized accounts.
- Desktop creates, edits, archives and reactivates inventory products with versioned offline proposals. Only product creation records opening stock.
- Desktop can view private product photos and queue replacements or removals offline. Cloud and Desktop refresh after either client changes the photo, and stale drafts require explicit review.
- Cloud manages warehouses, tracks inventory and receipts by location, and records atomic transfers with an auditable document. Existing stock starts in the main warehouse, where checkout continues to reserve and fulfil sales.
- Cloud tracks purchase orders from draft to delivery. Partial and complete deliveries create numbered stock receipts and update the order in the same transaction. Cancelling outstanding units preserves prior receipts and stock movements.
- Cloud manages supplier profiles and numbered stock receipts. Each receipt posts all reviewed product quantities in one transaction and keeps the supplier name and invoice reference in its history. An interrupted request can be retried with the same receipt identity.
- Desktop also prepares purchase orders and linked deliveries offline. Cloud and Desktop enforce the same order and product versions when changes synchronize, and a rejected delivery preserves its quantities for review.
- Desktop manages suppliers and stock receipts from Inventory. Reviewed changes can be queued without a connection, and a conflicting receipt keeps its quantities for review against Cloud.
- Desktop can create services, variants and add-ons with professional assignments. New services use the persistent synchronization queue and are bookable once acknowledged by the server.
- Desktop queues edits to existing service details offline. Cloud checks the version before applying the edit, and rejected drafts can be compared and resubmitted from Sync conflicts.

- Weekly team shifts in the web admin with dated overrides, absence intervals and links to individual schedules. [Scheduling guide](docs/date-shifts.md).
- Native weekly team shifts read the offline replica, mark pending blocks and open the selected professional's calendar. Dates and names remain visible while scrolling, and a date field jumps directly to a week.
- Desktop appointment details show confirmed rooms and equipment after sync, including when reopened offline. Web and Desktop calendars can filter appointments by the resource reserved.
- Web and Desktop offer a daily resource view with actual room and equipment usage, shared capacity and active waitlist holds. Desktop can reopen previously viewed days offline.

- Single-location checkout, cash sessions, receipt/refund reconciliation, retail stock and staff commissions; configurable deposits and a hosted Redsys card/Bizum adapter, with optional explicitly consented membership renewal.
- Gift cards, prepaid plans, memberships, loyalty points and bounded promotion codes. Customer booking reviews bind the offer, discounted total and deposit; uncertain requests recover their original visit.
- Recurring appointment series, held waitlist offers, shared room/equipment capacity, service variants/extras/combinations, date-specific shifts, treatment processing intervals and explicitly configured concurrent professional work.
- Client controls/tags, reviewed CSV transfer, private photos and versioned intake forms; completed-visit reviews, moderated public portfolio, booking links/QR/widget and separately consented local social creative.
- Scoped staff access and English/Spanish operational interfaces, with regression coverage for mobile/desktop, light/dark, accessibility and uncertain-response recovery.
- Per-visit review invitations for verified clients with commercial email permission. Reputation shows delivery status and the production smoke test checks replay and delivery through the standalone worker using an isolated SMTP sink.
- Optional quantity and unit per inventory pack, independent of stock counts and available in product details and CSV. New isolated Booksy projections retain this data when the archived source provides it.
- Native inventory search and product details in GPUI. Authorized users can update pack content with a version check and review concurrent changes without losing their draft.
- Native stock history, deliveries, consumption and physical counts per product. Submitted movements survive a lost connection or app restart and retry against the original server generation.

### Changed

- CI preserves browser traces from failed attempts even when the retry passes.

- The web proxy bounds the wait for API response headers and keeps established sync streams open.
- The agenda's new appointment form keeps one pending submission and starts a clean draft when a different slot is selected.
- Recurring appointment reviews mark individual dates unavailable and use the same professional capacity and processing windows as appointment creation.
- Pausing public booking also pauses new customer series previews and creation. Previously committed requests remain recoverable, and the team can still book.
- Unpaid appointments and imported visits awaiting billing review remain visible to authorized cashiers after the assigned professional becomes inactive.
- Web and GPUI stock movements retain the same set across pages and CSV exports when new movements commit. Load the latest movements explicitly to include them. [Inventory guide](docs/inventory.md).
- Removing a staff portrait requires confirmation for the version shown when opening the dialog.
- Open web and desktop staff views follow portrait changes through the existing sync stream. An upload retains the version reviewed when the file was selected.
- Removing a team portrait retains a write revision, so a draft from before an intervening upload and removal cannot recreate the photo. Upload clients must use the directory's `portraitAbsenceVersion` when present.
- Web stock movements can retry the original submission after a reload in the same tab. Stock writes require the server generation from the reviewed product.
- Scheduling protects frozen active-work intervals independently from a visit's full client span. Rooms and equipment remain occupied during processing; legacy visits keep continuous blocking.
- Offline desktop proposals retain reviewed catalog terms and timing across sync. Changed terms require a new proposal; rescheduling cannot silently accept them.
- Production Compose waits for the standalone notification worker to start its queues and verify access to their PostgreSQL tables before treating it as ready.
- Restored deployments check notification worker readiness before and after reopening Caddy. Interrupted or failed checks close the selected proxy.
- Recovery reopening rejects stale Compose settings or a worker still connected to the previous database.
- Portable Booksy recovery can rehearse a separate native database with public booking paused. It keeps the original archive private and verifies that credentials and outbound queues stay empty.
- The restored-copy rehearsal checks secure owner sign-in, the imported calendar and the public booking pause through the normal API with synthetic accounts.
- The optional operational write rehearsal moves an imported appointment through the agenda API and checks its frozen services, equipment, stale-version rejection and incremental sync.
- The restored-agenda rehearsal exercises real desktop device enrollment, signed renewal, live updates and revocation with a disposable device key.

### Delivery status

- This expansion remains in development. [The delivery checklist](docs/FEATURE-EXPANSION.md) tracks unfinished marketing, mobile and additional single-business features. Vendor credentials, a production domain and verified salon content remain external activation steps; no deployment or bank activation is implied.

### Fixed

- Submitting a new password after a reset or staff invitation uses one account-email rate-limit attempt.

- Production Compose waits for Caddy to load its listener configuration before reporting the gateway healthy.

- Database recovery restores the exact archive verified by checksum, including when a newer backup replaces the input file during validation.

- Screen readers can identify the appointment reschedule form once the form and its heading are visible.

- Campaign email tests charge the owner’s quota only for committed send claims. Stale drafts, failed claims and replays preserve the available quota.

- Signed-in customers can view and purchase available plans in their Packages and Memberships tabs.

- Desktop calendar downloads use separate network and staff-account quotas so a team opening an empty replica on a shared network can keep using the web agenda and sign-in.

- Re-running first-owner setup finishes authentication initialization before closing the database.

- Web and Desktop let owners verify unknown imported appointment prices before reconciling external payments. The original payment and invoice holds remain in place until reconciliation.

- Booksy recovery verifies archived product fingerprints before inventory classification columns existed and after migrating their root labels, while rejecting changed links.

## [0.1.0] - 2026-11-15

First release: a self-hostable booking and salon-management platform for one salon.

### Added

- **Booking core** (API, Postgres): services, staff, weekly working hours, time off, availability search with DST-safe computation, buffers and minimum notice, appointments with versioned reschedule, cancel and status transitions. A Postgres exclusion constraint (`btree_gist`) is the source of truth against double booking; conflicts surface as `409 slot_taken`.
- **Auth and RBAC**: Better Auth (email and password, Valkey-backed sessions), roles `owner`, `staff` and `client`, a policy matrix, audit log, global and strict rate limits, owner bootstrap command.
- **Account security**: email verification, password reset and staff invitations without user enumeration, per-address email throttle, CSRF origin checks, security headers and a nonce-based CSP.
- **Web app** (TanStack Start, English and Spanish es-AR, light and dark, responsive from 360 px): public booking flow, client account (appointments, reschedule, cancel, profile, notification preferences), staff and owner dashboard (today, drag-and-keyboard calendar, clients, services, team hours and time off, reports with CSV export, settings), consent screen and unsubscribe page.
- **Offline sync**: `POST /sync/push` (idempotent), `GET /sync/pull` (cursor, tombstones) and `GET /sync/stream` (SSE), with a change log written by deferred Postgres triggers.
- **Desktop client** (Rust, GPUI): offline-first front-desk calendar over a SQLite replica and outbox, sync engine, conflict review. The release workflow requires Linux x86_64 and signed and notarized macOS 15+ packages for Intel and Apple Silicon.
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
