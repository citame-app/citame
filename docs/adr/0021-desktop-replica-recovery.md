# ADR 0021 — Fence desktop edits across database restores

## Context

A restored database can reuse both appointment versions and sync cursors. It can also be missing the receipt for a mutation the original database already applied. The cursor-ahead recovery in ADR 0008 cannot distinguish those cases from ordinary offline sync.

## Decision

All API replicas serving a database use the same configured sync generation. Keep it stable during upgrades and assign a unique value when activating restored data. The API rejects an entire push with an older or missing generation before mutating rows or receipts. The original `initial` history accepts clients that omit the generation.

Desktop reads the outbox and its generation in one SQLite snapshot. On a generation change it atomically resets the mirror and moves queued edits to Conflicts. Previously open conflicts also require manual review. It persists the rebuild state through restarts and waits for a complete snapshot before accepting new local edits. It checks the generation of both the rendered agenda and incoming sync pages to fence stale UI or network work.

## Consequences

Recovered proposals retain their full payload for review. Their previous versions cannot be resubmitted via the conflict actions. Operators can copy the proposal, inspect the restored agenda and make a fresh change. Older desktops require an upgrade after a restore. The restore runbook holds public access and the worker during validation.
