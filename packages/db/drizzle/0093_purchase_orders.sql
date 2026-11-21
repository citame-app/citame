CREATE TYPE purchase_order_status AS ENUM ('draft', 'ordered', 'partially_received', 'received', 'cancelled');
--> statement-breakpoint
CREATE TABLE purchase_order (
  id uuid PRIMARY KEY,
  number integer GENERATED ALWAYS AS IDENTITY UNIQUE,
  status purchase_order_status NOT NULL DEFAULT 'draft',
  version integer NOT NULL DEFAULT 1,
  supplier_id uuid NOT NULL REFERENCES inventory_supplier(id),
  supplier_name text NOT NULL,
  supplier_reference text,
  expected_on date,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ordered_at timestamptz,
  closed_at timestamptz,
  CONSTRAINT purchase_order_version_positive CHECK (version > 0),
  CONSTRAINT purchase_order_dates_valid CHECK (
    (status NOT IN ('ordered', 'partially_received', 'received') OR ordered_at IS NOT NULL)
    AND ((status IN ('received', 'cancelled')) = (closed_at IS NOT NULL))
    AND (status <> 'draft' OR ordered_at IS NULL)
  )
);
--> statement-breakpoint
CREATE INDEX purchase_order_status_number_idx ON purchase_order(status, number);
--> statement-breakpoint
CREATE TABLE purchase_order_line (
  order_id uuid NOT NULL REFERENCES purchase_order(id),
  product_id uuid NOT NULL REFERENCES retail_product(id),
  position integer NOT NULL,
  name text NOT NULL,
  sku text NOT NULL,
  quantity integer NOT NULL,
  received_quantity integer NOT NULL DEFAULT 0,
  PRIMARY KEY (order_id, product_id),
  CONSTRAINT purchase_order_line_position UNIQUE (order_id, position),
  CONSTRAINT purchase_order_line_quantity_valid CHECK (
    quantity BETWEEN 1 AND 999999999 AND received_quantity BETWEEN 0 AND quantity AND position BETWEEN 1 AND 50
  )
);
--> statement-breakpoint
CREATE TABLE purchase_order_command (
  order_id uuid NOT NULL REFERENCES purchase_order(id),
  actor_user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  PRIMARY KEY (order_id, actor_user_id, idempotency_key)
);
--> statement-breakpoint
ALTER TABLE stock_receipt ADD COLUMN purchase_order_id uuid REFERENCES purchase_order(id);
--> statement-breakpoint
CREATE INDEX stock_receipt_purchase_order_idx ON stock_receipt(purchase_order_id) WHERE purchase_order_id IS NOT NULL;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sync_purchase_order_commerce
AFTER INSERT OR UPDATE OR DELETE ON purchase_order
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION sync_record_live_view('commerce');
