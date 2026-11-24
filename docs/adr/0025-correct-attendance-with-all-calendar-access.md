# 0025. Correct attendance with all-calendar edit access

**Status** Accepted

## Context

[ADR 0004](0004-admin-api-and-reporting.md) originally reserved corrections between completed and no-show for owners. The current Cloud calendar and API also allow corrections for staff with both calendar edit permission and access to all calendars. Reception and management roles can use that permission in Cloud.

## Decision

Desktop follows the same rule, using the server's last confirmed calendar edit permission and scope. Users who can edit only their own calendars can record initial attendance after the appointment starts. All-calendar editors can also change completed to no-show or no-show to completed. Cancellation remains terminal.

A correction carries the reviewed appointment version and uses the existing `appointment.set_status` sync operation. The API rechecks permissions, appointment version and [booking protection](../booking-deposits.md). Closed protected bookings remain final. Desktop keeps a rejection in the conflict list with the requested outcome so staff can review the current appointment.

## Consequences

Web and Desktop share the authorization and server-side effects of a correction. When Desktop is offline, the last confirmed scope controls which actions it offers. The server decides whether a queued change can apply after reconnection.
