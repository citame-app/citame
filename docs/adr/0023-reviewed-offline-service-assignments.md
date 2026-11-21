# ADR 0023 — Review service assignments before replaying offline edits

## Context

An owner can change which professionals perform a service from Cloud or Desktop. An offline change can arrive after the team changed in Cloud. The catalogue determines which new bookings are valid.

## Decision

Desktop queues the reviewed team and proposed team for each service. The server compares the reviewed set with the current set under the scheduling lock. It uses the same assignment writer as Cloud and records the mutation receipt for safe retry. The restore generation rule from ADR 0021 applies.

This extends the conflict rules in ADR 0007 and the outbox rules in ADR 0008. An acknowledged assignment stays visible in the outbox until the client pulls through the acknowledgment cursor. The push loop skips that entry. SQLite retains the acknowledged state through restart.

Desktop applies queued assignment changes to local booking eligibility in creation order. An owner may queue another edit against a pending team, followed by new bookings. The server processes the same order and validates the current assignment when it creates a booking. A rejected edit or booking remains available for review.

Variant and add-on quotes cover the booking terms, including the option label and eligible base services. The editorial catalogue revision is tracked separately. Existing replicas receive the new quote through the sync log, and the current legacy quote remains accepted during rollout.

## Consequences

The canonical replica stores only confirmed links. An empty confirmed catalogue of links means no one is assigned. Existing appointments keep their original professional and service details when the team changes.
