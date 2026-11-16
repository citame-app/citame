ALTER TABLE "client_profile" ADD COLUMN "tags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "client_profile" ADD COLUMN "booking_access" text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "client_profile" ADD COLUMN "booking_access_reason" text;--> statement-breakpoint
ALTER TABLE "client_profile" ADD COLUMN "controls_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "client_profile" ADD CONSTRAINT "client_profile_controls_valid" CHECK ("client_profile"."booking_access" in ('normal','blocked','trusted') and "client_profile"."controls_version">0 and cardinality("client_profile"."tags")<=20);