-- Announce existing itinerary links without modifying the appointments.
SELECT pg_advisory_xact_lock(hashtextextended('sob.sync_change', 0));
--> statement-breakpoint
INSERT INTO "sync_change" ("entity", "row_id", "op")
SELECT 'appointment', a.id::text, 'upsert'
FROM "appointment_visit_part" AS part
JOIN "appointment" AS a ON a.id = part.appointment_id
WHERE a.deleted_at IS NULL
ORDER BY a.id;
