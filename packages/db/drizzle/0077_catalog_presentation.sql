ALTER TABLE "service" ADD COLUMN IF NOT EXISTS "category" text;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN IF NOT EXISTS "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN IF NOT EXISTS "online_booking" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN IF NOT EXISTS "client_instructions" text;--> statement-breakpoint
UPDATE "service" SET "category" = trim("category") WHERE "category" <> trim("category");--> statement-breakpoint
SET CONSTRAINTS "sync_record_service" IMMEDIATE;--> statement-breakpoint
ALTER TABLE "service"
  DROP CONSTRAINT IF EXISTS "service_category_valid",
  DROP CONSTRAINT IF EXISTS "service_sort_order_valid",
  DROP CONSTRAINT IF EXISTS "service_instructions_valid";--> statement-breakpoint
ALTER TABLE "service" ADD CONSTRAINT "service_category_valid" CHECK ("service"."category" is null or (length(trim("service"."category")) between 1 and 100 and "service"."category"=trim("service"."category")));--> statement-breakpoint
ALTER TABLE "service" ADD CONSTRAINT "service_sort_order_valid" CHECK ("service"."sort_order" between 0 and 100000);--> statement-breakpoint
ALTER TABLE "service" ADD CONSTRAINT "service_instructions_valid" CHECK ("service"."client_instructions" is null or length("service"."client_instructions")<=2000);--> statement-breakpoint
SET CONSTRAINTS "sync_record_service" DEFERRED;
