# 0024. Keep campaign email test claims and quota in one transaction

**Status** Accepted

## Context

[ADR 0003](0003-auth-rbac-sessions.md) puts general request throttling in Valkey. A campaign email test also records a pending send before contacting SMTP. A separate quota debit can survive a failed claim and block a valid retry. Status checks and duplicate requests do not start a send.

## Decision

Keep general request throttling in Valkey. For the campaign email test’s per-owner quota, count committed pending-send audit entries in the current fixed minute. PostgreSQL supplies the clock. A transaction-scoped lock per owner serializes claims across drafts. Recording the claim and charging the quota are the same database write.

The API resolves the reviewed draft, eligibility and replays before acquiring the owner lock. It contacts SMTP only after the claim commits. Failed transactions leave quota available. Claimed sends count even when SMTP later rejects them or delivery is unconfirmed.

## Consequences

All API instances that use the same database share the quota. The existing audit indexes support the owner and time filters. This follows the account email precedent of checking delivery limits in the database transaction described in [ADR 0011](0011-production-hardening.md).
