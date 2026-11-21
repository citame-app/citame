-- Keep reviewed payment evidence valid across scheduling and note edits.
ALTER TABLE "appointment_context"
  ADD COLUMN "billing_version" integer DEFAULT 1 NOT NULL,
  ADD COLUMN "source_payment_unverified" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE FUNCTION appointment_context_billing_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(OLD.source, OLD.source_ref, OLD.paid, OLD.invoiced, OLD.source_payment_unverified)
     IS DISTINCT FROM ROW(NEW.source, NEW.source_ref, NEW.paid, NEW.invoiced, NEW.source_payment_unverified) THEN
    NEW.billing_version := OLD.billing_version + 1;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER appointment_context_billing_version
BEFORE UPDATE ON "appointment_context"
FOR EACH ROW EXECUTE FUNCTION appointment_context_billing_version();
--> statement-breakpoint
-- Re-announce undocumented source payments to existing desktop replicas.
SELECT pg_advisory_xact_lock(hashtextextended('sob.sync_change', 0));
--> statement-breakpoint
INSERT INTO "sync_change" ("entity", "row_id", "op")
SELECT 'appointment', booking.id::text, 'upsert'
FROM "appointment" AS booking
WHERE booking.deleted_at IS NULL
  AND EXISTS (
    SELECT 1 FROM "appointment_context" AS annotation
    WHERE annotation.appointment_id = booking.id
      AND annotation.source = 'booksy'
      AND annotation.paid IS NULL
      AND annotation.invoiced IS NOT TRUE
  )
ORDER BY booking.id;
