ALTER TABLE "marketing_campaign" ADD COLUMN "purpose" text DEFAULT 'campaign' NOT NULL;--> statement-breakpoint
UPDATE "marketing_campaign" SET "purpose" = 'review_request'
WHERE EXISTS (
  SELECT 1 FROM "marketing_delivery"
  WHERE "campaign_id" = "marketing_campaign"."id" AND "review_appointment_id" IS NOT NULL
);--> statement-breakpoint
ALTER TABLE "marketing_campaign" ADD CONSTRAINT "marketing_campaign_purpose_valid" CHECK ("marketing_campaign"."purpose" in ('campaign','review_request'));
