CREATE TABLE "email_delivery" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"revision" uuid NOT NULL,
	"settings" jsonb NOT NULL,
	"encrypted_secret" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_delivery_singleton" CHECK ("email_delivery"."id" = 1)
);
