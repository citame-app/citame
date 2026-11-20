-- Refresh existing replicas without changing appointment versions or source records.
SELECT pg_advisory_xact_lock(hashtextextended('sob.sync_change', 0));
--> statement-breakpoint
INSERT INTO "sync_change" ("entity", "row_id", "op")
SELECT 'appointment', a.id::text, 'upsert'
FROM "appointment" AS a
WHERE a.deleted_at IS NULL
  AND EXISTS (
    SELECT 1 FROM "appointment_context" AS source
    WHERE source.appointment_id = a.id
      AND source.source = 'booksy'
  )
ORDER BY a.id;
