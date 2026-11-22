# ADR 0006: Staff and owner dashboard

Status: accepted (Phase 3b-2). Builds on the `/admin` layout, guards and design system of [ADR 0005](0005-web-app.md) and the API of [ADR 0004](0004-admin-api-and-reporting.md).

## Context

Phase 3a left a complete admin API and Phase 3b-1 left an empty `/admin` shell. This phase fills it: a dense but calm operations tool for a busy front desk, usable from a phone at the chair and from a 1440px desk monitor.

## Scope and routes

| Route             | Who                | What                                                                                          |
| ----------------- | ------------------ | --------------------------------------------------------------------------------------------- |
| `/admin`          | owner, staff       | Today: stats, next up, appointments waiting for an outcome (complete / no-show), day timeline |
| `/admin/calendar` | owner, staff       | Day and week grid, walk-in booking, appointment drawer, drag and keyboard rescheduling        |
| `/admin/clients`  | owner, staff       | Server-side paged table, client page (history, notes, phone), owner-only soft delete          |
| `/admin/services` | owner              | Catalog CRUD, staff assignment, live preview of the client-facing card                        |
| `/admin/staff`    | owner, staff       | Owner: team list, create account, (de)activate, hours editor, time off. Staff: own schedule   |
| `/admin/reports`  | owner, staff (own) | Presets and custom range, tiles, two charts with table alternatives, CSV export               |
| `/admin/settings` | owner              | Salon name, timezone, slot interval, minimum notice, booking window                           |

Navigation is role based (`features/admin/nav.ts`, pure and tested): a sidebar on desktop, a bottom bar on phones (four most used sections plus "More" for the rest). `adminGuard` redirects staff away from owner pages to `/admin?notice=forbidden`, which shows an explicit message; clients go to `/account`. The API stays the authority; the guard only decides what to show.

## Decisions

### State: URL first, TanStack Query for server state, no TanStack DB

Table state (page, sort, search), calendar state (view, date, team filter), report range and staff tabs live in the URL (validated with `validateSearch`), so every screen is deep-linkable and survives reload and back/forward. Server state is TanStack Query; TanStack Store keeps only what is not worth a URL (it already backs the booking notes draft).

**TanStack DB was evaluated and not adopted.** Checked with Context7 and npm: the latest `@tanstack/react-db` is `1.0.0-rc.1.5` (a release candidate), and its sync-oriented collections pay off with a push channel, which arrives with Phase 4 (sync protocol). Today a salon has tens of appointments per day; Query gives us what we need (cache, optimistic updates through `onMutate`/rollback, invalidation, focus and interval refetch) on a stable 5.x API. Revisit when Phase 4 lands and DB reaches 1.0.

### Tables: TanStack Table 9 with server-side state

`@tanstack/react-table` 9.3 (feature-based API): only `rowSortingFeature` and `columnVisibilityFeature` are loaded, rows are not sorted or paginated client-side (`manualSorting`; the API pages). One `DataTable` primitive renders a real `<table>` from `md` up and the same rows as a card list below it (the title cell opens the row, the other cells become a `dl`), plus a column visibility menu and a pager. Small fully loaded lists (services, team, report breakdowns) sort in memory and hide the pager. Sort buttons expose `aria-sort`.

### Charts: Recharts 3.10 with an accessible frame

Recharts 3 supports React 19 (peer range checked) and enables its keyboard/screen-reader layer by default. Every chart sits in `ChartFrame`: a labelled `figure`, a one-sentence text summary (also the chart's `aria-label`), a button that reveals the same numbers as a real table, and a designed empty state. Color is never the only cue: the stacked status chart has a legend, and the series use the contrast-checked tokens (accent, success, warning, neutral). One series, one hue; no dual axis. Charts render after mount (Recharts measures the DOM) and honor `prefers-reduced-motion` (`isAnimationActive="auto"`). Currency is displayed as ARS because the report API assumes a single currency (ADR 0004).

### Calendar

`GET /appointments/calendar` returns everything in one response; the client lays it out.

- **Columns.** Day view: one column per team member (owner can filter; staff only ever get their own, the API pins it). Week view: seven day columns for one team member.
- **Layout** is pure and tested (`layoutBlocks`: overlap lanes, clamping; `gridHours`: the grid grows to hold every window and appointment; DST-correct `zonedInstant`). 1.6 px per minute (30 min is 48 px), minimum block height 44 px.
- **Layers.** Working windows are the light background, the rest is dimmed, time off is hatched with its reason, the current-time marker is a labelled line, cancelled appointments are hidden unless asked for.
- **Status is never color alone.** Each status has its own icon, label, and border style (booked: rose, solid; completed: green, check; no-show: amber, dashed, alert icon; cancelled: grey, struck through). Blue-free palette on purpose: rose, green, amber and grey stay distinguishable under the common color-vision deficiencies, and every block's accessible name carries time, client, services and status.
- **Creating.** Clicking an empty spot, the "New appointment" button and the `n` key open the same sheet (client search or inline new client, services of the chosen team member, time snapped to the salon grid). Staff and owners may override the minimum notice (default on for walk-ins; hours, time off and the horizon are still enforced; the API audits the override).
- **Moving.** Desktop: pointer drag (Pointer Events, mouse and pen; touch scrolls instead). Keyboard: focus a block and press Alt+Arrow (Up/Down one slot, Left/Right one column). Anywhere: the drawer's "Reschedule" reuses the booking slot picker (the phone path). Moves are optimistic, send `override` for the notice rule, and roll back on failure.
- **Errors.** `slot_taken`, `slot_unavailable`, `version_conflict`, `invalid_state`, `has_future_appointments` map to friendly messages with a recovery (`features/admin/problems.ts`): a move conflict leaves a persistent banner with "Open appointment"; a stale version offers "Reload latest"; the walk-in form keeps its input and focuses the time field.
- **Freshness.** Refetch on window focus and every 30 seconds (the `Updated hh:mm` label and a refresh button make it visible). Live push belongs to Phase 4.
- **Shortcuts** (documented in a help dialog, `?`): `t` today, `←`/`[` and `→`/`]` previous/next, `d` day, `w` week, `n` new, `r` refresh, Alt+arrows move a focused appointment. They are ignored while typing and while a dialog is open.

### Mutations and feedback

Status changes and moves are optimistic with snapshot rollback (`useStatusChange`, `useMoveAppointment`); everything else shows a toast on success and a friendly message on failure. Destructive actions (cancel, delete client, deactivate service or staff, remove time off) use `ConfirmDialog`. Forms with edits (client, hours, settings) register an `UnsavedGuard` (router blocker plus `beforeunload`); sheets ask before discarding.

### Staff deactivation

A 409 `has_future_appointments` opens a panel listing the blocking appointments (fetched from the calendar endpoint in 42-day windows up to the booking horizon, de-duplicated). Each can be moved to an active colleague who performs all its services or cancelled in place; "Deactivate now" enables when none is left.

### Hours and time off

The weekly editor supports several ranges per day, copy-to-days, and the same validation as the API (end after start, no overlap; touching ranges allowed). Saving shows the `conflicts` the API returns as a warning list (appointments that no longer fit are never moved automatically); conflicts that already exist are shown on load. Time off uses salon-local dates and times converted to instants; staff manage only their own entries.

### API change (own commit)

`GET` and `PATCH /admin/settings` (owner only): name, timezone (validated IANA), slot granularity (5, 10, 15, 20, 30, 60), minimum notice, booking window. A request that changes nothing writes and audits nothing; audit entries (`settings.update`) list field names only. `updateSalonSettingsRequestSchema` lives in `@sob/contracts`. Availability reads the settings on every request, so a change applies immediately.

### i18n

All copy goes through the existing catalogs, split per area under `src/i18n/messages/admin/` (each file holds its `en` and neutral `es-AR` side by side, the type system enforces the same keys, and the existing parity test covers the union). Dates, times, durations, money and percentages use `Intl` in the salon timezone.

### Testing

Strict TDD in three layers, test first for every unit: pure logic (`bun test`: nav, zoned time, calendar layout, drag geometry, keyboard moves, hours model, price parsing, report ranges and CSV), components (`bun test` with happy-dom and Testing Library against a stubbed `fetch`), and Playwright against the real production stack at a phone and a desktop viewport (role matrix, walk-in booking, outcomes, drag and keyboard moves, conflict recovery, client search/sort/paging, service CRUD, hours with conflict warnings, time off, deactivation flow, report numbers and CSV against a seeded fixture, settings reflected in availability, i18n, dark mode, no horizontal scroll, axe on every route in both themes).

### Client net collections

Cloud and Desktop use the same client report and export the ten highest positive net collections in EUR. The calculation uses recorded external payments and completed refunds in the selected salon-local dates and the checkout's staff scope. It groups historical checkouts under the current client identity after merges. Anonymous sales, deleted client profiles and redemptions of stored value are outside the ranking. The report requires financial and client directory permissions.

### Client sales by family

The client profile opens a scoped financial report in Cloud and Desktop. The existing financial report endpoint accepts a client identifier and resolves it to the current profile within the reporting snapshot. Date and professional filters apply to the same checkout ledger and settlement calculations as the centre report. Scoped exports identify the client and keep the settled family, included tax, external collections and refunds distinct. Cash register sessions remain available in the centre report. The client view requires financial report and client directory permissions.

### Team occupancy

Cloud and Desktop use the same report snapshot for the selected salon-local dates and team member. Effective shifts use the current weekly schedule and dated overrides. The report counts overlapping blocks once and clips them to the shift. Reserved staff work includes active bookings and completed visits inside the remaining shift. Simultaneous reservations count once, and processing gaps are taken from each appointment's frozen work plan. Completed and missed time sums each visit's calendar duration within the report dates, including concurrent visits. Occupancy uses all currencies and is blank when no shift time remains. Schedule changes refresh open reports. The report and its CSV measure planned time from the calendar. Attendance records would be required to report hours actually worked.

### Public business profile

The owner can prepare a private profile in Web or Desktop with a description, category, address, public contact details, HTTPS links, amenities, home visits and house rules. The booking homepage fetches the current published profile on entry, including client-side navigation. The separate profile endpoint disables HTTP caching, and the sync feed exposes unpublished details only to the owner.

Both editors use the salon settings revision and replica generation. The native editor queues changed fields while offline. A stale revision or generation requires review against the current settings before saving again. Review merges only the fields edited in the draft, including explicit clears, so unrelated remote updates are retained.

## Consequences

- Two new runtime dependencies in `apps/web`: `@tanstack/react-table` 9.3.1 and `recharts` 3.10.1 (plus `react-is` 19.3.1, a Recharts peer).
- The public header stays on admin pages (theme, language, account) while the footer is hidden; the shell adds the section navigation.
- Known gaps: week view shows one team member at a time; the calendar is not virtualized (fine for one salon); the reschedule slot picker reads public availability, so the appointment's own current slot is not offered as free; reports show one currency; no push updates (Phase 4); the E2E suite assumes a fresh database for its fixtures (it randomizes dates to tolerate reruns).
