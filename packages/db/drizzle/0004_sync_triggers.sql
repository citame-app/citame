-- Hand-written: Drizzle cannot express functions or triggers. See docs/adr/0007-sync-protocol.md.
--
-- Every write to a synced table appends to sync_change from a DEFERRED constraint trigger, i.e.
-- at COMMIT time, in the same transaction as the write. Running at commit matters: the trigger
-- takes one global advisory lock (held until the transaction ends) before drawing the next
-- `seq`, so seq order equals commit order and a pull cursor can never skip a late commit. At
-- that point the transaction no longer waits for row locks, so the lock cannot deadlock with
-- application locks.
CREATE FUNCTION sync_record_change() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  entity_name text := TG_ARGV[0];
  id_column   text := TG_ARGV[1];
  as_parent   boolean := COALESCE(TG_ARGV[2], '') = 'parent';
  rec         jsonb;
  change_op   text;
  new_seq     bigint;
  mutation    text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    rec := to_jsonb(OLD);
    change_op := 'delete';
  ELSE
    rec := to_jsonb(NEW);
    change_op := CASE WHEN rec ->> 'deleted_at' IS NOT NULL THEN 'delete' ELSE 'upsert' END;
  END IF;
  -- Child rows (appointment snapshots) re-announce their parent, which still exists.
  IF as_parent THEN
    change_op := 'upsert';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('sob.sync_change', 0));

  INSERT INTO sync_change (entity, row_id, op)
  VALUES (entity_name, rec ->> id_column, change_op)
  RETURNING seq INTO new_seq;

  -- Lets the push endpoint learn which seq a mutation produced (see sync_mutation.applied_seq).
  mutation := NULLIF(current_setting('sob.mutation_id', true), '');
  IF mutation IS NOT NULL THEN
    UPDATE sync_mutation SET applied_seq = new_seq WHERE mutation_id = mutation::uuid;
  END IF;

  RETURN NULL;
END;
$fn$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sync_record_appointment AFTER INSERT OR UPDATE OR DELETE ON appointment
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sync_record_change('appointment', 'id');
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sync_record_appointment_service AFTER INSERT OR UPDATE OR DELETE ON appointment_service
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sync_record_change('appointment', 'appointment_id', 'parent');
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sync_record_client AFTER INSERT OR UPDATE OR DELETE ON client_profile
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sync_record_change('client', 'id');
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sync_record_service AFTER INSERT OR UPDATE OR DELETE ON service
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sync_record_change('service', 'id');
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sync_record_staff AFTER INSERT OR UPDATE OR DELETE ON staff_profile
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sync_record_change('staff', 'id');
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sync_record_service_staff AFTER INSERT OR UPDATE OR DELETE ON service_staff
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sync_record_change('service_staff', 'id');
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sync_record_working_hours AFTER INSERT OR UPDATE OR DELETE ON working_hours
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sync_record_change('working_hours', 'id');
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sync_record_time_off AFTER INSERT OR UPDATE OR DELETE ON time_off
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sync_record_change('time_off', 'id');
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sync_record_salon_settings AFTER INSERT OR UPDATE OR DELETE ON salon_settings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sync_record_change('salon_settings', 'id');
--> statement-breakpoint
-- Backfill: rows that predate the log must reach clients that pull from seq 0, so `since=0` is
-- always a full snapshot.
INSERT INTO sync_change (entity, row_id, op)
SELECT 'appointment', id::text, CASE WHEN deleted_at IS NULL THEN 'upsert' ELSE 'delete' END FROM appointment
UNION ALL SELECT 'client', id::text, CASE WHEN deleted_at IS NULL THEN 'upsert' ELSE 'delete' END FROM client_profile
UNION ALL SELECT 'service', id::text, CASE WHEN deleted_at IS NULL THEN 'upsert' ELSE 'delete' END FROM service
UNION ALL SELECT 'staff', id::text, CASE WHEN deleted_at IS NULL THEN 'upsert' ELSE 'delete' END FROM staff_profile
UNION ALL SELECT 'service_staff', id::text, CASE WHEN deleted_at IS NULL THEN 'upsert' ELSE 'delete' END FROM service_staff
UNION ALL SELECT 'working_hours', id::text, CASE WHEN deleted_at IS NULL THEN 'upsert' ELSE 'delete' END FROM working_hours
UNION ALL SELECT 'time_off', id::text, CASE WHEN deleted_at IS NULL THEN 'upsert' ELSE 'delete' END FROM time_off
UNION ALL SELECT 'salon_settings', id::text, 'upsert' FROM salon_settings;
