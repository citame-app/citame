CREATE TABLE "booking_fee_movement" (
	"id" uuid PRIMARY KEY NOT NULL,
	"appointment_id" uuid NOT NULL,
	"checkout_id" uuid NOT NULL,
	"refund_id" uuid,
	"amount_cents" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_fee_movement_refundId_unique" UNIQUE("refund_id"),
	CONSTRAINT "booking_fee_movement_nonzero" CHECK ("booking_fee_movement"."amount_cents" <> 0)
);
--> statement-breakpoint
CREATE TABLE "booking_policy" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"terms" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_policy_singleton" CHECK ("booking_policy"."id" = 1 and "booking_policy"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "booking_protection" (
	"appointment_id" uuid PRIMARY KEY NOT NULL,
	"checkout_id" uuid NOT NULL,
	"state" text NOT NULL,
	"terms" jsonb NOT NULL,
	"policy_version" integer NOT NULL,
	"deposit_cents" integer NOT NULL,
	"fee_cents" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"cancellation_cutoff" timestamp with time zone NOT NULL,
	"accepted_by" text,
	"accepted_at" timestamp with time zone,
	"waiver_reason" text,
	"finalised_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_protection_checkoutId_unique" UNIQUE("checkout_id"),
	CONSTRAINT "booking_protection_money_valid" CHECK ("booking_protection"."deposit_cents" between 0 and 999999999 and "booking_protection"."fee_cents" between 0 and "booking_protection"."deposit_cents"),
	CONSTRAINT "booking_protection_state_valid" CHECK ("booking_protection"."state" in ('pending','confirmed','waived','completed','cancelled','expired','no_show'))
);
--> statement-breakpoint
ALTER TABLE "booking_fee_movement" ADD CONSTRAINT "booking_fee_movement_appointment_id_appointment_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_fee_movement" ADD CONSTRAINT "booking_fee_movement_checkout_id_checkout_id_fk" FOREIGN KEY ("checkout_id") REFERENCES "public"."checkout"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_fee_movement" ADD CONSTRAINT "booking_fee_movement_refund_id_checkout_refund_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."checkout_refund"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_protection" ADD CONSTRAINT "booking_protection_appointment_id_appointment_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_protection" ADD CONSTRAINT "booking_protection_checkout_id_checkout_id_fk" FOREIGN KEY ("checkout_id") REFERENCES "public"."checkout"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_protection" ADD CONSTRAINT "booking_protection_accepted_by_user_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "booking_fee_movement_checkout_idx" ON "booking_fee_movement" USING btree ("checkout_id");--> statement-breakpoint
CREATE INDEX "booking_protection_expiry_idx" ON "booking_protection" USING btree ("state","expires_at");