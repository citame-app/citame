-- Give existing offline replicas the revision needed to review edits.
-- Reannounce the current rows without changing services, staff links or appointment snapshots.
SELECT pg_advisory_xact_lock(hashtextextended('sob.sync_change', 0));
--> statement-breakpoint
INSERT INTO sync_change (entity, row_id, op)
SELECT 'service', id::text, 'upsert'
FROM service
WHERE deleted_at IS NULL;
