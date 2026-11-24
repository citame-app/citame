ALTER TABLE checkout
  ADD COLUMN superseded_at timestamptz,
  ADD CONSTRAINT checkout_superseded_refund
    CHECK (superseded_at IS NULL OR (appointment_id IS NOT NULL AND status = 'refunded'));
--> statement-breakpoint
DROP INDEX checkout_active_appointment_unique;
--> statement-breakpoint
CREATE UNIQUE INDEX checkout_active_appointment_unique
  ON checkout (appointment_id) WHERE status <> 'void' AND superseded_at IS NULL;
--> statement-breakpoint
CREATE INDEX checkout_appointment_history_idx
  ON checkout (appointment_id) WHERE appointment_id IS NOT NULL;
