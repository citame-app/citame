# ADR 0022 — Review offline salon settings against Cloud revisions

## Context

Salon settings can change the display time zone, reminder timing and public booking availability. A queued settings edit may arrive after an owner has made a different decision in Cloud. The generic last-writer-wins rule in ADR 0007 uses device time and is unsuitable for these reviewed changes.

## Decision

Desktop saves a settings patch and the reviewed Cloud revision in the existing outbox. The server checks that revision under the settings row lock and uses the sync mutation receipt for retries. The flat patch used by earlier clients retains its existing behavior. ADR 0021 still fences mutations across database restores.

Desktop keeps the pending proposal visible through restart. When the server acknowledges a write, the proposal remains visible until the replica pulls through the acknowledged cursor. The confirmed settings continue to drive the calendar and public booking policies. Only owners receive the full settings snapshot. A conflict preserves the proposal for an explicit review against the current settings.

## Consequences

Desktop sends one reviewed settings proposal at a time. An owner may review a conflicting proposal or discard it explicitly. Reminder transport credentials, WhatsApp onboarding and payment provider configuration are outside this setting mutation.
