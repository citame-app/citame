# ADR 0015: Shared resources use transactional unit allocations

Status: accepted for the single-location Sisters of Beauty installation.

## Decision

Model interchangeable resource pools and per-service quantities. Store an individual allocation row per required unit, with a frozen service position and start/end offsets relative to its appointment or waitlist offer. Derive absolute times and occupancy from the owning row through database triggers. Protect every active unit with a deferred exclusion constraint on `(resource, unit, time range)`.

Public availability computes peak pooled demand across the requested windows. A write first tries existing unit labels. When those labels are fragmented but capacity exists, it repacks future interchangeable allocations with interval coloring. In-progress allocations remain fixed. This avoids hiding available pooled capacity merely because previous bookings used different unit numbers.

Changing service requirements upgrades affected future booked appointments and active unexpired offers atomically. Lock every affected owner before deleting or inserting its allocations: FK checks and cancellation triggers otherwise allow deadlocks or missed newly inserted children. Reject an impossible upgrade without advancing its revision or changing any existing allocation. Historical and in-progress visits retain their allocations.

## Lock protocol

Use one scheduling advisory lock per salon installation. Acquire it before per-professional calendar locks and before capacity-related parent/child writes. This deliberate serialization is suitable for the current one-location workload.

When a receipt already exists, financial and appointment lifecycle writers take the receipt lock first, then the scheduling coordinator, before acquiring value/client/inventory or appointment locks. The coordinator must be acquired at the receipt entry boundary, including authenticated bank callbacks and refund/reconciliation paths; taking it late during payment status refresh would invert client/appointment lock dependencies. Counter-only receipts without an appointment do not require the coordinator.

Resource configuration takes the coordinator, its catalog row and all affected visit/offer rows before touching reservation children. It never acquires existing receipt locks. Waitlist commands hold their entry lock before acquiring the coordinator; resource configuration does not acquire waitlist-entry locks. Releasing an expired offer's resource rows marks them released without changing the queue entry, so it does not invert that order. Accepting an offer still checks its exact deadline.

Deferred exclusions allow transient overlap inside a transaction while swapping unit assignments. They remain authoritative at commit. The trigger derives `active` from owner state and a release marker; a caller cannot reactivate a cancelled owner's capacity by writing the child directly. The constraint grammar and deferral semantics follow [PostgreSQL CREATE TABLE](https://www.postgresql.org/docs/18/sql-createtable.html).

## Consequences

Reservations, series, waitlists, deposits and resource edits share one capacity invariant. Reconfiguration can fail due to existing demand and must keep the operator's draft. Individual unit numbers are internal; named non-interchangeable equipment uses separate capacity-one pools. The planner can be split by location if multisite is introduced, after adding location ownership to every relevant row and lock key.

This decision does not introduce processing gaps, parallel services, indefinite series or an external inventory-management system. Those features require their own scheduling semantics and integration coverage.
