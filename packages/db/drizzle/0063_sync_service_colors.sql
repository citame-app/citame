-- Older desktop replicas discarded color when they decoded service rows. Announce the
-- current rows again through the normal authenticated sync feed to hydrate the existing cache.
SELECT pg_advisory_xact_lock(hashtextextended('sob.sync_change', 0));
--> statement-breakpoint
INSERT INTO "sync_change" ("entity", "row_id", "op")
SELECT 'service', "id"::text, 'upsert'
FROM "service"
WHERE "deleted_at" IS NULL AND "color" IS NOT NULL
ORDER BY "id";
