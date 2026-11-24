# ADR 0028 — Project appointment edits only over their reviewed revision

## Context

Desktop projects the local outbox over the Cloud replica as described in [ADR 0008](0008-desktop-client.md). A pull can contain a newer appointment while a local edit is waiting for a receipt. Projecting a stale cancellation can hide the current booking. A later edit in the same local chain can also appear to match the Cloud version because it predicted the version of a different edit.

## Decision

Apply each queued appointment edit only to its reviewed version. Once an edit lacks that basis, keep the remaining edits for that appointment in the outbox and show the last valid projection. Prevent further edits while the pending chain awaits its receipts. A rejection puts dependent edits in Conflicts for explicit review. An acknowledgement allows the existing receipt and pull rules to reconcile the chain.

## Consequences

The confirmed slot and professional remain visible while a stale local proposal is pending. No queued edit is removed by rendering or by pulling a newer appointment. Locally valid edits still appear immediately while working offline.
