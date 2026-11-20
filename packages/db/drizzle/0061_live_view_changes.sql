-- Reuse the replica cursor for online-only views without storing payment, contact or queue data
-- in the replica. Emit at most one marker per topic per transaction, ordered at commit alongside
-- the ordinary sync entries.
CREATE FUNCTION sync_record_live_view() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  topic text := TG_ARGV[0];
  marker text := 'sob.live_view_' || topic;
BEGIN
  IF NULLIF(current_setting(marker, true), '') IS NULL THEN
    PERFORM set_config(marker, '1', true);
    PERFORM pg_advisory_xact_lock(hashtextextended('sob.sync_change', 0));
    INSERT INTO sync_change (entity, row_id, op) VALUES ('live_view', topic, 'upsert');
  END IF;
  RETURN NULL;
END;
$fn$;
--> statement-breakpoint
DO $fn$
DECLARE
  entry record;
BEGIN
  FOR entry IN SELECT * FROM (VALUES
    ('cash_session', 'commerce'),
    ('cash_movement', 'commerce'),
    ('checkout', 'commerce'),
    ('checkout_line', 'commerce'),
    ('checkout_payment', 'commerce'),
    ('checkout_refund', 'commerce'),
    ('retail_product', 'commerce'),
    ('stock_movement', 'commerce'),
    ('waitlist_entry', 'waitlist'),
    ('waitlist_offer', 'waitlist'),
    ('waitlist_policy', 'waitlist'),
    ('calendar_notice_archive', 'inbox')
  ) AS views(table_name, topic) LOOP
    EXECUTE format(
      'CREATE CONSTRAINT TRIGGER sync_record_live_view AFTER INSERT OR UPDATE OR DELETE ON %I
       DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sync_record_live_view(%L)',
      entry.table_name, entry.topic
    );
  END LOOP;
END;
$fn$;
