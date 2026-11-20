-- Checkout changes update an appointment's calendar indicators without editing its version.
CREATE CONSTRAINT TRIGGER sync_record_checkout_billed
AFTER INSERT ON "checkout"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (NEW.appointment_id IS NOT NULL AND NEW.status IN ('paid', 'partially_refunded', 'refunded'))
EXECUTE FUNCTION sync_record_change('appointment', 'appointment_id', 'parent');
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sync_record_checkout_billing_status
AFTER UPDATE OF status ON "checkout"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (
  NEW.appointment_id IS NOT NULL AND OLD.status IS DISTINCT FROM NEW.status
  AND (
    OLD.status IN ('paid', 'partially_refunded', 'refunded')
    OR NEW.status IN ('paid', 'partially_refunded', 'refunded')
  )
)
EXECUTE FUNCTION sync_record_change('appointment', 'appointment_id', 'parent');
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sync_record_checkout_billing_removed
AFTER DELETE ON "checkout"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (OLD.appointment_id IS NOT NULL AND OLD.status IN ('paid', 'partially_refunded', 'refunded'))
EXECUTE FUNCTION sync_record_change('appointment', 'appointment_id', 'parent');
--> statement-breakpoint
SELECT pg_advisory_xact_lock(hashtextextended('sob.sync_change', 0));
--> statement-breakpoint
INSERT INTO "sync_change" ("entity", "row_id", "op")
SELECT 'appointment', a.id::text, 'upsert'
FROM "appointment" AS a
WHERE a.deleted_at IS NULL
  AND (
    a.requested_staff_id IS NOT NULL
    OR nullif(btrim(a.customer_comment), '') IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM "appointment_context" AS context WHERE context.appointment_id = a.id
    )
    OR EXISTS (
      SELECT 1 FROM "checkout" AS receipt
      WHERE receipt.appointment_id = a.id
        AND receipt.status IN ('paid', 'partially_refunded', 'refunded')
    )
  )
ORDER BY a.id;
