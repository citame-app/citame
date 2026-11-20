-- Re-announce the affected appointments for replicas already at the sync head.
SELECT pg_advisory_xact_lock(hashtextextended('sob.sync_change', 0));
--> statement-breakpoint
INSERT INTO "sync_change" ("entity", "row_id", "op")
SELECT 'appointment', a.id::text, 'upsert'
FROM "appointment" AS a
WHERE a.deleted_at IS NULL
  AND a.status <> 'cancelled'
  AND (
    EXISTS (
      SELECT 1 FROM "appointment_service" AS line
      WHERE line.appointment_id = a.id
        AND line.source_unpriced
        AND line.reviewed_price_cents IS NULL
    )
    OR EXISTS (
      SELECT 1 FROM "appointment_context" AS source
      WHERE source.appointment_id = a.id
        AND source.source = 'booksy'
        AND (source.paid IS TRUE OR source.invoiced IS TRUE)
    )
  )
ORDER BY a.id;
