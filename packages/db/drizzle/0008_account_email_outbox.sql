CREATE TABLE "account_email_outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"throttle_key" text NOT NULL,
	"payload" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"status" "reminder_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"locked_until" timestamp with time zone,
	"locked_by" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_email_outbox_idempotencyKey_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE INDEX "account_email_due_idx" ON "account_email_outbox" USING btree ("scheduled_for") WHERE "account_email_outbox"."status" in ('pending', 'processing');--> statement-breakpoint
CREATE INDEX "account_email_throttle_idx" ON "account_email_outbox" USING btree ("throttle_key","created_at");