CREATE TABLE inventory_classification (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  kind text NOT NULL,
  parent_id uuid REFERENCES inventory_classification(id),
  name text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT inventory_classification_valid CHECK (
    length(btrim(name)) > 0 AND position >= 0 AND version > 0
    AND (kind = 'category' OR (kind = 'brand' AND parent_id IS NULL))
    AND (parent_id IS NULL OR parent_id <> id)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX inventory_classification_root_name ON inventory_classification (kind, lower(name)) WHERE parent_id IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX inventory_classification_child_name ON inventory_classification (parent_id, lower(name)) WHERE parent_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX inventory_classification_parent_idx ON inventory_classification (parent_id);
--> statement-breakpoint
INSERT INTO inventory_classification (kind, name)
SELECT kind, min(label COLLATE "C")
FROM (
  SELECT 'category' AS kind, btrim(category) AS label FROM retail_product
  UNION ALL
  SELECT 'brand', btrim(brand) FROM retail_product
) AS labels
WHERE length(label) > 0
GROUP BY kind, lower(label);
--> statement-breakpoint
ALTER TABLE retail_product
  ADD COLUMN category_id uuid REFERENCES inventory_classification(id),
  ADD COLUMN subcategory_id uuid REFERENCES inventory_classification(id),
  ADD COLUMN brand_id uuid REFERENCES inventory_classification(id);
--> statement-breakpoint
CREATE INDEX retail_product_category_id_idx ON retail_product (category_id);
--> statement-breakpoint
CREATE INDEX retail_product_subcategory_id_idx ON retail_product (subcategory_id);
--> statement-breakpoint
CREATE INDEX retail_product_brand_id_idx ON retail_product (brand_id);
--> statement-breakpoint
UPDATE retail_product AS product SET category_id = entry.id
FROM inventory_classification AS entry
WHERE entry.kind = 'category' AND lower(entry.name) = lower(btrim(product.category));
--> statement-breakpoint
UPDATE retail_product AS product SET brand_id = entry.id
FROM inventory_classification AS entry
WHERE entry.kind = 'brand' AND lower(entry.name) = lower(btrim(product.brand));
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sync_inventory_classification_commerce
  AFTER INSERT OR UPDATE OR DELETE ON inventory_classification
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sync_record_live_view('commerce');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sync_record_live_view() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  topic text := TG_ARGV[0];
  marker text := 'sob.live_view_' || topic;
  changed_seq bigint;
  mutation text;
BEGIN
  IF NULLIF(current_setting(marker, true), '') IS NULL THEN
    PERFORM set_config(marker, '1', true);
    PERFORM pg_advisory_xact_lock(hashtextextended('sob.sync_change', 0));
    INSERT INTO sync_change (entity, row_id, op) VALUES ('live_view', topic, 'upsert')
      RETURNING seq INTO changed_seq;
    IF topic IN ('resource_catalogue', 'service_combinations', 'commerce') THEN
      mutation := NULLIF(current_setting('sob.mutation_id', true), '');
      IF mutation IS NOT NULL THEN
        UPDATE sync_mutation SET applied_seq = changed_seq
          WHERE mutation_id = mutation::uuid
            AND ((topic = 'resource_catalogue' AND kind IN ('resource.create', 'resource.update'))
              OR (topic = 'service_combinations' AND kind IN ('combination.create', 'combination.update'))
              OR (topic = 'commerce' AND kind IN ('product.create', 'product.update', 'product.photo', 'supplier.save', 'stock.receipt', 'purchase_order.write', 'warehouse.save', 'warehouse.transfer', 'warehouse.adjust', 'inventory.classification_save')));
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END;
$fn$;
