# ADR 0004: Admin API, schedule rules, calendar read model and reporting

Status: accepted (Phase 3a)

## Context

The dashboard (Phase 3b) needs to manage the catalog, the team and its schedules, the client directory, see a calendar and read reports. Phase 1 also left the booking rules (working hours, time off, notice, horizon) advisory: only availability search honored them. This phase adds the owner and staff API behind the existing RBAC policy, and promotes those rules to real validation.

Everything below is implemented as the thin HTTP layer over the same service-layer functions and the pure policy in `src/auth/policy.ts`, so MCP tools (Phase 6) can reuse it.

## Decisions

### Authorization (extends ADR 0003)

| Resource / action                                          | Client | Staff                         | Owner |
| ---------------------------------------------------------- | ------ | ----------------------------- | ----- |
| `/admin/services` (list, create, edit, deactivate, assign) | 403    | 403                           | yes   |
| `GET /admin/staff`                                         | 403    | only themselves               | all   |
| `PATCH /admin/staff/:id` (rename, activate, deactivate)    | 403    | 403                           | yes   |
| `GET /admin/staff/:id/working-hours`                       | 403    | own only                      | any   |
| `PUT /admin/staff/:id/working-hours`                       | 403    | 403                           | yes   |
| time off list, create, edit, delete                        | 403    | own entries only              | any   |
| `GET`, `PATCH /admin/clients[/:id]`                        | 403    | every client (front desk)     | yes   |
| `DELETE /admin/clients/:id`                                | 403    | 403                           | yes   |
| `GET /admin/reports/summary`                               | 403    | own numbers (query is pinned) | all   |
| `GET /appointments/calendar`                               | 403    | own calendar only             | any   |
| `GET /appointments` paging and `status` filter             | own    | own calendar                  | all   |

Router guards are per route, never `use("*")` inside a sub-router: Hono matches middleware by request path regardless of which router registered it, so a blanket guard in one `/admin` router would leak onto every router mounted after it.

### Rate limiter failure modes

The global limiter **fails open**: when Valkey errors the failure is logged and the request goes through, so a cache outage cannot take public browsing and booking down. The sign-in/sign-up limiter stays **fail-closed** (the error propagates as `500`), because letting brute force through is the worse failure for credential endpoints.

### Staff deactivation and demotion: `409 has_future_appointments`

Deactivating a staff calendar (`PATCH /admin/staff/:id {active:false}`) or demoting a staff account to client (which deactivates it) is refused while the calendar has any appointment that is not cancelled and has not ended yet. Nothing changes and nothing is audited. The owner must reassign (`PATCH /appointments/:id {staffId}`) or cancel first. Deleting a client behaves the same way for that client's upcoming appointments. The check runs under the per-calendar advisory lock that bookings use, so a booking cannot slip in between check and update. Booking and rescheduling also re-read `active` inside their own transaction, after taking that lock (`assertStaffActive`): a request that passed its pre-checks and then queued behind a committing deactivation is refused with `404 not_found` instead of landing on a closed calendar. Tests hold the deactivation transaction open to make that interleaving deterministic.

### Booking rules are real (`409 slot_unavailable`)

`POST /appointments` now rejects, inside the booking transaction and after taking the staff advisory lock:

- the block (duration plus buffers) not fully inside one working-hours range of the salon-local weekday (touching ranges count as one; a gap such as lunch cannot be crossed),
- overlap with time off,
- a start earlier than `now + minNoticeMinutes`,
- a local start date more than `maxDaysAhead` days ahead.

They use the new stable code `slot_unavailable` (409); `slot_taken` still means "someone else has that slot" and comes only from the exclusion constraint, which remains the source of truth for overlaps. Staff and owners may send `override: true` to bypass **only** the minimum notice (clients get `403`). The audit entry of `appointment.create` records `override` and `noticeOverridden` (whether the override was actually needed). Rescheduling uses exactly the same rules: a `PATCH` that actually changes `startsAt` or `staffId` is validated against the target calendar (hours, time off, horizon, notice) inside the transaction and answers `409 slot_unavailable`; staff and owners may send `override: true` for the notice rule only, clients get `403`, and the use is audited on `appointment.reschedule`. Re-sending the current start and staff, changing notes and changing status are not moves and are not re-validated, so an appointment that has drifted outside the hours (the conflict report below lists them) can still be cancelled, closed or annotated.

The rules are pure functions (`availability/rules.ts`) reused by availability search semantics (`compute.ts` shares the range resolution) and the conflict report.

### Appointment status transitions

`PATCH /appointments/:id` accepts `status` of `completed`, `no_show` or `cancelled` (never `booked`), always with the current `version`. A request either changes the status or moves the appointment, never both (`400`); notes may accompany either.

| From               | To                                  | Who                                           | When                                                                      |
| ------------------ | ----------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------- |
| booked             | completed, no_show                  | the calendar's staff member, owner            | only once `starts_at <= now` (injectable clock), else 409 `invalid_state` |
| booked             | cancelled                           | the client (own), the calendar's staff, owner | staff and owner: any time; the client: only before `starts_at`            |
| completed          | no_show, and back                   | owner only (a correction)                     | any time                                                                  |
| completed, no_show | cancelled, or the same status again | nobody                                        | 409 `invalid_state`                                                       |
| cancelled          | anything                            | nobody (terminal)                             | 409 `invalid_state`                                                       |

Clients can only cancel; marking an outcome is 403 for them even on their own appointment. A client changes an appointment (cancel, move, notes) only while it is `booked` and has not started: after the start it may be about to become a no-show, which a late cancel would erase, and once closed it is the salon's record. Such requests are `403`, except a cancel of an already closed appointment, which the state machine answers `409 invalid_state`. There is no notice period for clients beyond that: cancelling any time before the start is allowed. The audit action is `appointment.complete`, `appointment.no_show`, `appointment.cancel` or `appointment.status_correct`, with `fromStatus` and `toStatus`, written in the same transaction as the update and under the unchanged version check. Reports read these statuses.

### Working hours and time off never touch appointments

`PUT /admin/staff/:id/working-hours` replaces the staff member's entire weekly schedule (weekdays not mentioned become days off; ranges may touch but not overlap; `HH:MM` salon-local). Old rows are soft-deleted (they are sync tombstones). Time off is CRUD with soft delete. Neither operation moves or cancels bookings. Instead the response carries `conflicts`: upcoming, non-cancelled appointments that no longer fit, each with `reasons` (`outside_working_hours`, `time_off`). Hours responses list the hours-related conflicts of the whole schedule; time-off responses list only the bookings overlapping that entry. `GET .../working-hours` reports the current conflicts too. "Time off requests" are modeled as immediately effective entries: there is no approval workflow.

### Client directory

Staff see every client (front-desk need); only the owner soft-deletes. `GET /admin/clients` is offset-paged (`page`, `pageSize` max 100), searches name, email and phone (LIKE wildcards are escaped; phone also matches by digits so `(11) 5555` finds `+54 9 11 5555-0000`) and sorts by name, creation date or last visit (never-visited last). Each row carries `appointmentCount` and `lastVisitAt` over non-cancelled appointments. `PATCH` accepts only name, phone and notes; email and the login link are not editable here. Audit entries list changed field names, never values (notes can be private).

### Reports

`GET /admin/reports/summary?from=YYYY-MM-DD&to=YYYY-MM-DD&staffId=` (dates are salon-local, both inclusive, at most 366 days).

- **Bucketing is done by Postgres**: `starts_at AT TIME ZONE <salon timezone>` decides the local day, and the window is `[from 00:00, to+1 00:00)` in salon time, so a 23:30 booking never leaks into the next UTC day. The SQL returns buckets per (day, staff, status); `reports/aggregate.ts` is a pure function that sums, zero-fills the per-day series and ranks, tested against hand-computed fixtures.
- **Revenue** is the sum of the `appointment_service` price snapshots of `completed` appointments (catalog edits never rewrite history). It assumes a single currency; mixed currencies would need a per-currency breakdown.
- **No-show rate** is `no_show / (completed + no_show)` (appointments that should already have happened), rounded to four decimals, `null` without a basis.
- **Top services** are completed services ranked by count, then revenue, then name; the best 10.
- Staff get the same report pinned to their own calendar.

**Client visit frequency.** The client report groups canonical client identities by one, two, or
three or more completed visits matching the selected dates and professional. Any matching completed
line counts for its imported visit group, which is counted once per client. Appointments without a
visit group count individually. The categories are exclusive and cover every client in the report,
even if the client has no current group. The Web and native Desktop reports export the same category
keys and counts in a separate CSV and use the existing financial-report permissions.

### Calendar read model

`GET /appointments/calendar?from=&to=&staffIds=a,b` (instants, at most 42 days) returns, in one response: the columns (`staff`), appointments with `clientName` and `serviceNames` joined (cancelled included, check `status`), time off, and `workingWindows`, the recurring hours resolved to concrete instants through the timezone database (DST-correct). Without `staffIds` it covers all active staff; naming an inactive one explicitly is allowed. Staff are pinned to their own calendar.

### Appointment list

`GET /appointments` gains optional `page`, `pageSize` (default 50, max 200) and `status` (comma-separated). The response now always includes `page`, `pageSize` and `total` next to `appointments`. Existing callers keep working, but a result larger than the default page is now truncated: paginate.

### Audit

Every mutation writes its audit row in the same transaction: `service.create|update|activate|deactivate|staff_set`, `staff.update|activate|deactivate`, `working_hours.replace`, `time_off.create|update|delete`, `client.update|delete`, and `appointment.create` and `appointment.reschedule` with the override flags, and `appointment.complete|no_show|cancel|status_correct`. No-op edits (values unchanged) write nothing.

### Soft-deleted client with a login

Deleting a client profile that is linked to a login does not lock that person out: on their next authenticated request the principal loader restores the soft-deleted profile (history included) instead of colliding with its unique `user_id`. To really remove such a person, remove or change the account.

## Known gaps and follow-ups

- Single currency in reports; offset paging (fine at one-salon scale).
- The restore-on-next-request behavior above is silent (not audited).
