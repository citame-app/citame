-- Resource catalogue edits can alter allocations without changing the appointment version.
CREATE FUNCTION sync_record_booked_resource() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  before_id uuid;
  after_id uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN before_id := OLD.appointment_id; END IF;
  IF TG_OP <> 'DELETE' THEN after_id := NEW.appointment_id; END IF;
  IF before_id IS NULL AND after_id IS NULL THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (before_id, OLD.resource_id, OLD.name, OLD.service_position)
        IS NOT DISTINCT FROM (after_id, NEW.resource_id, NEW.name, NEW.service_position)
    THEN RETURN NULL; END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('sob.sync_change', 0));
  INSERT INTO "sync_change" ("entity", "row_id", "op")
  SELECT DISTINCT 'appointment', id::text, 'upsert'
  FROM (VALUES (before_id), (after_id)) AS affected(id)
  WHERE id IS NOT NULL
  ORDER BY id::text;
  RETURN NULL;
END;
$fn$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sync_booked_resource
AFTER INSERT OR UPDATE OR DELETE ON resource_reservation
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sync_record_booked_resource();
--> statement-breakpoint
-- Announce existing resource reservations without modifying appointments or allocations.
SELECT pg_advisory_xact_lock(hashtextextended('sob.sync_change', 0));
--> statement-breakpoint
INSERT INTO "sync_change" ("entity", "row_id", "op")
SELECT 'appointment', a.id::text, 'upsert'
FROM "appointment" AS a
WHERE a.deleted_at IS NULL
  AND EXISTS (SELECT FROM "resource_reservation" AS r WHERE r.appointment_id = a.id)
ORDER BY a.id;
