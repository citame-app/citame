# ADR 0016: Frozen professional work and concurrent capacity

Status: accepted. Extends ADR 0002's original continuous-block rule; physical resources keep ADR 0015's independent reservations.

An appointment's full client span still includes all service durations, processing and cleanup. It no longer represents every moment of professional work. Store an immutable ordered work plan on the appointment/offer, with optional processing metadata on frozen service snapshots. A null legacy plan means the entire original span.

Internal staff reservations use interchangeable units and half-open active intervals. A deferred GiST exclusion protects each staff/unit pair, while owner triggers derive times, identity and active state and completeness guards prevent orphaned occupancy. SQL profile changes and allocation triggers take the same calendar advisory lock. Versioned capacity is 1–6, default one; a decrease can recolour future bookkeeping units only when all active work still fits. Physical rooms/stations/equipment retain their independent full-window demand.

Reuse the existing pooled-resource sweep and interval-colouring functions to test peak work and reassign logical units. Preserve the global scheduling/calendar lock order and expire offer allocations without acquiring waitlist entries in reverse order. Offer acceptance transfers its own hold inside the existing transaction. No policy change silently edits appointments or money.

API reads, availability, booking, rescheduling, series, waitlists, delegated tools and offline replay use the same frozen work semantics. The desktop stores optional timing/capacity metadata compatibly and freezes newly reviewed proposals and quote hashes; local snapshot fields never go to the API. Changing only a rejected proposal's time cannot accept changed terms.

See [operation, migration and verification](../processing-and-capacity.md).
