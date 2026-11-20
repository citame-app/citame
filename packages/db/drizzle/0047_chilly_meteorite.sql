ALTER TYPE "public"."notification_channel" ADD VALUE 'whatsapp';--> statement-breakpoint
CREATE TABLE "whatsapp_connection" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"waba_id" text NOT NULL,
	"phone_id" text NOT NULL,
	"phone" text NOT NULL,
	"coexistence" boolean NOT NULL,
	"encrypted_token" text NOT NULL,
	"expires_at" timestamp with time zone,
	"rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_preference" ADD COLUMN "destination_hash" text;--> statement-breakpoint
ALTER TABLE "reminder" ADD COLUMN "whatsapp_dispatch_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reminder" ADD COLUMN "whatsapp_delivery" text;