# Recurring appointments

The calendar's **New appointment** form can repeat a visit weekly or monthly. Choose an interval from 1 to 12 and between 2 and 12 visits, then review the concrete dates before creating them. Every visit must fit the normal booking horizon, staff qualification, hours, time off and notice rules. An operator can override the same minimum notice rule as for a single booking; the override does not bypass other rules.

The preview is advisory. Creation rechecks availability under the calendar lock and creates every appointment, service snapshot, applicable receipt and notification in one transaction. A conflict leaves no partial series or inline client behind. Retrying the same request key returns the original series. Reusing that key for a changed request is rejected. Changed catalog prices, service timing, timezone, booking settings or deposit policy require a new review.

Dates keep the original wall-clock time in the salon timezone across daylight-saving changes. Monthly repetitions use the original day, clamped independently in shorter months: January 31 → February 28 → March 31. A later occurrence at an ambiguous or nonexistent local time is rejected; choose another time. The web form also rejects a nonexistent initial local time instead of silently moving the visit.

Each visit has its own appointment status, payment and accepted cancellation policy. A series does not charge a subscription or provide prepaid entitlements. Existing deposit consent/manager-waiver rules still apply independently to each visit. The browser operator form exposes a waiver only to a manager/owner. No real payment or message is sent by the isolated browser fixture.

Customers see each visit in their account, with a link to expand the full series. Calendar drawers show the recurrence position and let authorized operators navigate to another visit's date. Rescheduling and cancellation apply to one visit at a time; changing a visit does not move its siblings. Staff series reads are filtered by the visits' current calendars, so moving a visit does not expose it through a former professional's access. Clients may read only their own series.

The public REST contract additionally supports customer-scoped series creation with explicit accepted deposit terms; the current self-service booking wizard still creates a single visit. Bulk series editing/cancellation and an indefinitely rolling recurrence are not included in this delivery. Automated waitlists, constrained resources and service processing gaps remain separate scheduling work.

Run `bun run --cwd apps/web e2e:series` after building the web app. This starts the explicit local fixture with isolated Postgres/Valkey data and tests actual API/browser interactions without contacting a bank or message provider.
