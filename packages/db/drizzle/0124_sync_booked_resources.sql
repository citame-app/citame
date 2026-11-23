-- Announce existing resource reservations without modifying appointments or allocations.
SELECT pg_advisory_xact_lock(hashtextextended('sob.sync_change', 0));
--> statement-breakpoint
INSERT INTO "sync_change" ("entity", "row_id", "op")
SELECT 'appointment', a.id::text, 'upsert'
FROM "appointment" AS a
WHERE a.deleted_at IS NULL
  AND EXISTS (SELECT FROM "resource_reservation" AS r WHERE r.appointment_id = a.id)
ORDER BY a.id;
