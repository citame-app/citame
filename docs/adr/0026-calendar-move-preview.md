# ADR 0026. Reconcile calendar moves against live appointments

**Status** Accepted

## Context

[ADR 0006](0006-admin-dashboard.md) described restoring query snapshots after a failed move or attendance update. A live refresh can replace part of that snapshot while a PATCH is pending. Restoring the snapshot can briefly resurrect a cancelled appointment or undo a newer move.

## Decision

Keep confirmed calendar responses in TanStack Query. Project a pending move or status change over its matching appointment revision in the calendar view. Dropping the pending mutation restores the latest confirmed appointment. Mutation responses can update an existing cached appointment when its version is current or newer.

Grid moves, drawer actions and staff reassignment share one mutation key and a per-appointment admission check in the QueryClient. Pending writes survive client-side navigation within that session. Reschedule notices match the appointment, destination and revision of a local move. Cancellation notices require a confirmed local response before suppression. The deactivation panel keeps confirmed blockers until the server accepts a change.

Appointment notes and per-service annotations use the same admission check. An open detail resolves its appointment by ID if it leaves the displayed range, subject to the calendar's access rules. The note editor retains the draft while showing the latest saved text and requires explicit review before resubmission.

The protocol, server version check and conflict messages continue to determine acceptance and recovery.
