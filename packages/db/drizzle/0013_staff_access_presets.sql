CREATE TYPE "public"."staff_access_preset" AS ENUM('manager', 'receptionist', 'professional', 'restricted');--> statement-breakpoint
ALTER TABLE "staff_profile" ADD COLUMN "access_preset" "staff_access_preset" DEFAULT 'professional' NOT NULL;--> statement-breakpoint
ALTER TABLE "staff_profile" ADD COLUMN "access_version" integer DEFAULT 1 NOT NULL;