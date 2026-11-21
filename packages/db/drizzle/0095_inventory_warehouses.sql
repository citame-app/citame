CREATE TABLE inventory_warehouse (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inventory_warehouse_valid CHECK (length(btrim(name)) BETWEEN 1 AND 100 AND version > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX inventory_warehouse_name_unique ON inventory_warehouse (lower(name));
--> statement-breakpoint
ALTER TABLE retail_product ADD COLUMN stock_allocated integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE retail_product ADD CONSTRAINT retail_product_warehouse_allocation_valid
  CHECK (stock_allocated BETWEEN 0 AND stock_on_hand - stock_reserved);
--> statement-breakpoint
CREATE TABLE warehouse_stock (
  warehouse_id uuid NOT NULL REFERENCES inventory_warehouse(id),
  product_id uuid NOT NULL REFERENCES retail_product(id),
  quantity integer NOT NULL,
  PRIMARY KEY (warehouse_id, product_id),
  CONSTRAINT warehouse_stock_quantity_valid CHECK (quantity BETWEEN 0 AND 999999999)
);
--> statement-breakpoint
CREATE INDEX warehouse_stock_product_idx ON warehouse_stock (product_id);
--> statement-breakpoint
CREATE FUNCTION inventory_update_warehouse_allocation() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  target_product uuid;
  delta integer;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.product_id, NEW.warehouse_id) <> (OLD.product_id, OLD.warehouse_id) THEN
    RAISE EXCEPTION 'Warehouse stock identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    target_product := NEW.product_id;
    delta := NEW.quantity;
  ELSIF TG_OP = 'DELETE' THEN
    target_product := OLD.product_id;
    delta := -OLD.quantity;
  ELSE
    target_product := NEW.product_id;
    delta := NEW.quantity - OLD.quantity;
  END IF;
  IF delta <> 0 THEN
    UPDATE retail_product SET stock_allocated = stock_allocated + delta WHERE id = target_product;
  END IF;
  RETURN NULL;
END;
$fn$;
--> statement-breakpoint
CREATE TRIGGER inventory_warehouse_allocation AFTER INSERT OR UPDATE OR DELETE ON warehouse_stock
  FOR EACH ROW EXECUTE FUNCTION inventory_update_warehouse_allocation();
--> statement-breakpoint
CREATE TABLE stock_transfer (
  id uuid PRIMARY KEY,
  source_id uuid REFERENCES inventory_warehouse(id),
  source_name text,
  destination_id uuid REFERENCES inventory_warehouse(id),
  destination_name text,
  reason text NOT NULL,
  lines jsonb NOT NULL,
  created_by text REFERENCES "user"(id) ON DELETE SET NULL,
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_transfer_distinct_locations CHECK (source_id IS DISTINCT FROM destination_id),
  CONSTRAINT stock_transfer_line_count_valid CHECK (jsonb_typeof(lines) = 'array' AND jsonb_array_length(lines) BETWEEN 1 AND 50)
);
--> statement-breakpoint
ALTER TABLE stock_receipt
  ADD COLUMN warehouse_id uuid REFERENCES inventory_warehouse(id),
  ADD COLUMN warehouse_name text;
--> statement-breakpoint
ALTER TABLE stock_movement
  ADD COLUMN warehouse_id uuid REFERENCES inventory_warehouse(id),
  ADD COLUMN warehouse_name text,
  ADD COLUMN transfer_id uuid REFERENCES stock_transfer(id),
  ADD CONSTRAINT stock_movement_transfer_valid CHECK (
    transfer_id IS NULL OR (receipt_id IS NULL AND checkout_line_id IS NULL AND
      ((kind = 'receive' AND quantity_delta > 0) OR (kind = 'consume' AND quantity_delta < 0)))
  );
--> statement-breakpoint
CREATE INDEX stock_movement_warehouse_position_idx ON stock_movement (warehouse_id, ledger_position);
--> statement-breakpoint
CREATE UNIQUE INDEX stock_movement_transfer_product_kind ON stock_movement (transfer_id, product_id, kind)
  WHERE transfer_id IS NOT NULL;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sync_inventory_warehouse_commerce
  AFTER INSERT OR UPDATE OR DELETE ON inventory_warehouse
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sync_record_live_view('commerce');
