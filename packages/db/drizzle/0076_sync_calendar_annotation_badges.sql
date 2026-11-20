-- Re-announce scheduling indicators and Booksy provenance to existing desktop replicas.
SELECT pg_advisory_xact_lock(hashtextextended('sob.sync_change', 0));
--> statement-breakpoint
INSERT INTO "sync_change" ("entity", "row_id", "op")
SELECT 'appointment', a.id::text, 'upsert'
FROM "appointment" AS a
WHERE a.deleted_at IS NULL
  AND (
    a.requested_staff_id IS NOT NULL
    OR length(btrim(a.customer_comment)) > 0
    OR EXISTS (
      SELECT 1 FROM "appointment_context" AS annotation
      WHERE annotation.appointment_id = a.id
        AND (
          annotation.source = 'booksy'
          OR annotation.requested_staff_id IS NOT NULL
          OR length(btrim(annotation.internal_note)) > 0
          OR length(btrim(annotation.customer_comment)) > 0
        )
    )
  )
ORDER BY a.id;
