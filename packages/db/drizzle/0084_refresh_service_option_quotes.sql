-- Reannounce option quotes for existing replicas. Keep catalogue rows and booking history intact.
SELECT pg_advisory_xact_lock(hashtextextended('sob.sync_change', 0));
--> statement-breakpoint
INSERT INTO sync_change (entity, row_id, op)
SELECT 'service', id::text, 'upsert'
FROM service
WHERE deleted_at IS NULL AND catalog_kind IN ('variant', 'addon');
