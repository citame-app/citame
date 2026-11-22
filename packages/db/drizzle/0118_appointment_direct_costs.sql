CREATE TABLE appointment_direct_cost (
  appointment_id uuid PRIMARY KEY REFERENCES appointment(id),
  labour_cents integer,
  materials_cents integer,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT appointment_direct_cost_valid CHECK (
    (labour_cents IS NULL OR labour_cents BETWEEN 0 AND 999999999)
    AND (materials_cents IS NULL OR materials_cents BETWEEN 0 AND 999999999)
    AND version > 0
  )
);
--> statement-breakpoint
CREATE INDEX checkout_appointment_settlement_idx ON checkout (fulfilled_at, id)
  WHERE appointment_id IS NOT NULL AND fulfilled_at IS NOT NULL;
--> statement-breakpoint
CREATE INDEX commission_accrual_checkout_idx ON commission_accrual (checkout_id);
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sync_appointment_direct_cost_commerce
AFTER INSERT OR UPDATE OR DELETE ON appointment_direct_cost
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION sync_record_live_view('commerce');
