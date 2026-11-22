CREATE TABLE peak_price_policy (
  id integer PRIMARY KEY,
  version integer NOT NULL,
  rules jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT peak_price_policy_singleton CHECK (id = 1 AND version > 0),
  CONSTRAINT peak_price_policy_rules_valid CHECK (jsonb_typeof(rules) = 'array' AND jsonb_array_length(rules) <= 100)
);
--> statement-breakpoint
ALTER TABLE appointment_service ADD COLUMN peak_surcharge_cents integer;
--> statement-breakpoint
ALTER TABLE appointment_service ADD CONSTRAINT appointment_service_peak_price_valid CHECK
  (peak_surcharge_cents IS NULL OR peak_surcharge_cents BETWEEN 1 AND price_cents);
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sync_peak_price_policy
AFTER INSERT OR UPDATE OR DELETE ON peak_price_policy
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION sync_record_live_view('peak_prices');
