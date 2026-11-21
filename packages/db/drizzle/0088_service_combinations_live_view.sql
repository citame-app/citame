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
    IF topic IN ('resource_catalogue', 'service_combinations') THEN
      mutation := NULLIF(current_setting('sob.mutation_id', true), '');
      IF mutation IS NOT NULL THEN
        UPDATE sync_mutation SET applied_seq = changed_seq
          WHERE mutation_id = mutation::uuid
            AND ((topic = 'resource_catalogue' AND kind IN ('resource.create', 'resource.update'))
              OR (topic = 'service_combinations' AND kind IN ('combination.create', 'combination.update')));
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END;
$fn$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sync_service_combinations_view
AFTER INSERT OR UPDATE OR DELETE ON service_combination
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION sync_record_live_view('service_combinations');
