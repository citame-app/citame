CREATE TYPE "public"."notification_category" AS ENUM('transactional', 'reminder');--> statement-breakpoint
CREATE TYPE "public"."notification_channel" AS ENUM('email', 'sms');--> statement-breakpoint
CREATE TYPE "public"."reminder_kind" AS ENUM('confirmation', 'reminder_24h', 'reminder_2h', 'cancellation', 'rescheduled');--> statement-breakpoint
CREATE TYPE "public"."reminder_status" AS ENUM('pending', 'processing', 'sent', 'failed', 'skipped', 'cancelled');--> statement-breakpoint
CREATE TABLE "notification_preference" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"category" "notification_category" NOT NULL,
	"enabled" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reminder" (
	"id" uuid PRIMARY KEY NOT NULL,
	"appointment_id" uuid NOT NULL,
	"kind" "reminder_kind" NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"appointment_version" integer NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"status" "reminder_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"provider_message_id" text,
	"locked_until" timestamp with time zone,
	"locked_by" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reminder_once_per_version" UNIQUE("appointment_id","kind","channel","appointment_version")
);
--> statement-breakpoint
ALTER TABLE "client_profile" ADD COLUMN "locale" text;--> statement-breakpoint
ALTER TABLE "salon_settings" ADD COLUMN "reminder_first_lead_minutes" integer DEFAULT 1440;--> statement-breakpoint
ALTER TABLE "salon_settings" ADD COLUMN "reminder_second_lead_minutes" integer DEFAULT 120;--> statement-breakpoint
ALTER TABLE "notification_preference" ADD CONSTRAINT "notification_preference_client_id_client_profile_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client_profile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder" ADD CONSTRAINT "reminder_appointment_id_appointment_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_preference_unique" ON "notification_preference" USING btree ("client_id","channel","category");--> statement-breakpoint
CREATE INDEX "reminder_due_idx" ON "reminder" USING btree ("scheduled_for") WHERE "reminder"."status" in ('pending', 'processing');--> statement-breakpoint
CREATE INDEX "reminder_appointment_idx" ON "reminder" USING btree ("appointment_id");--> statement-breakpoint
ALTER TABLE "salon_settings" ADD CONSTRAINT "salon_settings_reminder_first_positive" CHECK ("salon_settings"."reminder_first_lead_minutes" > 0);--> statement-breakpoint
ALTER TABLE "salon_settings" ADD CONSTRAINT "salon_settings_reminder_second_positive" CHECK ("salon_settings"."reminder_second_lead_minutes" > 0);