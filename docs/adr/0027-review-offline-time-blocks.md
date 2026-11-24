# ADR 0027 — Review offline calendar block conflicts against the saved revision

## Context

Desktop keeps pending edits in the outbox and projects them over the Cloud replica, as described in [ADR 0008](0008-desktop-client.md). If a pulled block already has a newer revision, projecting an old update or removal can hide valid unavailability before the server rejects the edit.

## Decision

Project a revision-checked time block edit only over the revision it targets. Keep stale edits in the outbox until the server reconciles them. Once Desktop has pulled through the cursor from a rejected write, offer a review against the saved block. An explicit retry uses the revision displayed during review. Discarding a proposal remains a separate action.

Queue only the edited fields. Offline edits that already contain every field require the reviewer to select the intended values because old Desktop builds stored all fields for every update.

## Consequences

The calendar shows the saved block when an earlier offline proposal cannot apply. The operator can still recover that proposal from Conflicts. A newer revision or write permission change can prevent submission. Appointment projection continues to follow [ADR 0008](0008-desktop-client.md).
