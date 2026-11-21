-- Announce the editability of existing standalone emails to desktop replicas.
SELECT pg_advisory_xact_lock(hashtextextended('sob.sync_change', 0));
--> statement-breakpoint
INSERT INTO "sync_change" ("entity", "row_id", "op")
SELECT 'client', c.id::text, 'upsert'
FROM "client_profile" AS c
WHERE c.deleted_at IS NULL AND c.merged_into_id IS NULL AND c.user_id IS NULL
ORDER BY c.id;
