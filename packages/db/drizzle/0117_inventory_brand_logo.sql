CREATE TABLE inventory_brand_logo (
  brand_id uuid PRIMARY KEY REFERENCES inventory_classification(id) ON DELETE CASCADE,
  version uuid NOT NULL,
  image bytea,
  CONSTRAINT inventory_brand_logo_size CHECK (octet_length(image) BETWEEN 1 AND 262144)
);
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sync_inventory_brand_logo_commerce
AFTER INSERT OR UPDATE OR DELETE ON inventory_brand_logo
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION sync_record_live_view('commerce');
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
              OR (topic = 'commerce' AND kind IN ('product.create', 'product.update', 'product.photo', 'supplier.save', 'stock.receipt', 'purchase_order.write', 'warehouse.save', 'warehouse.transfer', 'warehouse.adjust', 'inventory.classification_save', 'inventory.classification_reorder', 'inventory.brand_logo')));
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END;
$fn$;
