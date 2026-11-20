# ADR 0018 Frozen capacity on imported appointments

Status: accepted for the Booksy migration candidate. Extends ADR 0015 and ADR 0016.

Booksy already accepted appointments with overlapping demands above the candidate's configured capacity. The candidate preserves these appointments, their times, and their assigned staff and equipment. Only the importer assigns historical units. A reservation on those units must still match its immutable source window and assignment. Deferred database constraints preserve exclusion within each unit and reject mixed demand above capacity when an ordinary booking is present.

The configured professional and equipment limits are also the limits for new bookings and offers. Availability counts every active reservation, including imported ones. Rescheduling retains the equipment already assigned and tests its capacity at the destination. A moved visit uses ordinary units. A catalogue edit keeps existing allocations that still need historical resource units and updates other future eligible visits under the same transaction as the catalogue change.

Booksy catalogue resource alternatives are a single choice per service. A new appointment or offer freezes the selected resource, while service windows remain sequential. Catalogue availability and allocation use the same capacity accounting.
