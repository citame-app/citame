# ADR 0026. Reconcile calendar moves against live appointments

**Status** Accepted

## Context

[ADR 0006](0006-admin-dashboard.md) described restoring query snapshots after a failed move. A live refresh can replace part of that snapshot while a PATCH is pending. Restoring the snapshot can briefly resurrect a cancelled appointment or undo a newer move.

## Decision

Keep confirmed calendar responses in TanStack Query. Project a pending move over its matching appointment revision in the calendar view. Dropping the pending mutation restores the latest confirmed position. Mutation responses can update an existing cached appointment when its version is current or newer.

Grid, keyboard and drawer moves share one mutation key and a per-appointment admission check in the QueryClient. Pending moves survive client-side navigation within that session. The live notification provider matches a local move by appointment, destination and revision when suppressing its duplicate reschedule notice.

The protocol, server version check and conflict messages continue to determine acceptance and recovery.
