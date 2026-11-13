-- Hand-written: Drizzle cannot express exclusion constraints.
-- Double-booking guard (source of truth; availability search is only advisory).
-- Ranges are half-open so back-to-back appointments are allowed. Cancelled and
-- soft-deleted appointments do not block a slot.
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
ALTER TABLE "appointment"
  ADD CONSTRAINT "appointment_no_overlap"
  EXCLUDE USING gist (
    "staff_id" WITH =,
    tstzrange("starts_at", "ends_at", '[)') WITH &&
  )
  WHERE ("status" <> 'cancelled' AND "deleted_at" IS NULL);
