ALTER TABLE "stock_movement" ADD COLUMN "ledger_position" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "stock_movement_ledger_position_idx" ON "stock_movement" USING btree ("ledger_position") WHERE "stock_movement"."ledger_position" > 0;--> statement-breakpoint
CREATE SEQUENCE stock_movement_ledger_position_seq OWNED BY stock_movement.ledger_position;--> statement-breakpoint
-- Use the existing deferred sync lock so positions follow commit order.
-- In particular, a transaction waiting on stock can start before the current ledger window.
CREATE FUNCTION stamp_stock_movement_ledger() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('sob.sync_change', 0));
  UPDATE stock_movement
    SET ledger_position = nextval('stock_movement_ledger_position_seq')
    WHERE id = NEW.id;
  RETURN NULL;
END;
$fn$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER stamp_stock_movement_ledger
AFTER INSERT ON stock_movement
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION stamp_stock_movement_ledger();
