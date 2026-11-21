CREATE TABLE inventory_supplier (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  email text,
  phone text,
  tax_id text,
  notes text,
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT inventory_supplier_version_positive CHECK (version > 0)
);
--> statement-breakpoint
CREATE TABLE stock_receipt (
  id uuid PRIMARY KEY,
  number integer GENERATED ALWAYS AS IDENTITY UNIQUE,
  supplier_id uuid REFERENCES inventory_supplier(id),
  supplier_name text,
  received_on date NOT NULL,
  invoice_reference text,
  notes text,
  lines jsonb NOT NULL,
  line_count integer NOT NULL,
  created_by text REFERENCES "user"(id) ON DELETE SET NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_receipt_actor_key UNIQUE (created_by, idempotency_key),
  CONSTRAINT stock_receipt_lines_valid CHECK (line_count BETWEEN 1 AND 50 AND jsonb_array_length(lines) = line_count),
  CONSTRAINT stock_receipt_supplier_snapshot CHECK ((supplier_id IS NULL) = (supplier_name IS NULL))
);
--> statement-breakpoint
ALTER TABLE stock_movement
  ADD COLUMN receipt_id uuid REFERENCES stock_receipt(id),
  ADD CONSTRAINT stock_movement_receipt_kind CHECK (receipt_id IS NULL OR kind = 'receive');
--> statement-breakpoint
CREATE UNIQUE INDEX stock_movement_receipt_product
  ON stock_movement(receipt_id, product_id) WHERE receipt_id IS NOT NULL;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sync_inventory_supplier_commerce
AFTER INSERT OR UPDATE OR DELETE ON inventory_supplier
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION sync_record_live_view('commerce');
