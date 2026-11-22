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
