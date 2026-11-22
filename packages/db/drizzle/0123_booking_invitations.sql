ALTER TABLE marketing_campaign DROP CONSTRAINT marketing_campaign_purpose_valid;
--> statement-breakpoint
-- Earlier applications cannot edit or expand this purpose. Existing workers can deliver
-- its reviewed one-time queue, which already contains the exact selected recipients.
ALTER TABLE marketing_campaign ADD CONSTRAINT marketing_campaign_purpose_valid CHECK (
  CASE WHEN purpose = 'booking_invitation'
    THEN trigger = 'manual' AND CASE
      WHEN jsonb_typeof(audience->'selectedClientIds') = 'array'
      THEN jsonb_array_length(audience->'selectedClientIds') BETWEEN 1 AND 100
      ELSE FALSE END
    ELSE purpose IN ('campaign', 'review_request') AND NOT (audience ? 'selectedClientIds')
  END
);
