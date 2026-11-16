CREATE TABLE "pass_mandate" (
	"id" uuid PRIMARY KEY NOT NULL,
	"contract_id" uuid NOT NULL,
	"merchant_code" text NOT NULL,
	"terminal" text NOT NULL,
	"environment" text NOT NULL,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"encrypted_payload" text,
	"expiry" text NOT NULL,
	"last4" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pass_mandate_contractId_unique" UNIQUE("contract_id"),
	CONSTRAINT "pass_mandate_valid" CHECK ("pass_mandate"."environment" in ('test','live') and "pass_mandate"."currency"='EUR' and length("pass_mandate"."expiry")=4 and ("pass_mandate"."last4" is null or length("pass_mandate"."last4")=4) and ("pass_mandate"."revoked_at" is not null or "pass_mandate"."encrypted_payload" is not null))
);
--> statement-breakpoint
ALTER TABLE "checkout_payment" ADD COLUMN "mandate_requested" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "checkout_payment" ADD COLUMN "merchant_initiated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "checkout_payment" ADD COLUMN "recurring_mandate_id" uuid;--> statement-breakpoint
ALTER TABLE "pass_mandate" ADD CONSTRAINT "pass_mandate_contract_id_pass_contract_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."pass_contract"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_payment" ADD CONSTRAINT "checkout_payment_recurring_mandate_id_pass_mandate_id_fk" FOREIGN KEY ("recurring_mandate_id") REFERENCES "public"."pass_mandate"("id") ON DELETE no action ON UPDATE no action;