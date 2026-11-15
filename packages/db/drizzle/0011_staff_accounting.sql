CREATE TABLE "commission_accrual" (
	"id" uuid PRIMARY KEY NOT NULL,
	"staff_id" uuid NOT NULL,
	"checkout_id" uuid NOT NULL,
	"checkout_line_id" uuid NOT NULL,
	"basis_cents" integer NOT NULL,
	"rate_basis_points" integer NOT NULL,
	"earned_cents" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commission_accrual_checkoutLineId_unique" UNIQUE("checkout_line_id"),
	CONSTRAINT "commission_accrual_money_valid" CHECK ("commission_accrual"."basis_cents" between 0 and 999999999 and "commission_accrual"."rate_basis_points" between 0 and 10000 and "commission_accrual"."earned_cents" between 0 and "commission_accrual"."basis_cents")
);
--> statement-breakpoint
CREATE TABLE "commission_payout" (
	"id" uuid PRIMARY KEY NOT NULL,
	"staff_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"reference" text NOT NULL,
	"created_by" text,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commission_payout_staff_key_unique" UNIQUE("staff_id","idempotency_key"),
	CONSTRAINT "commission_payout_positive" CHECK ("commission_payout"."amount_cents" between 1 and 999999999)
);
--> statement-breakpoint
CREATE TABLE "commission_policy" (
	"staff_id" uuid PRIMARY KEY NOT NULL,
	"service_basis_points" integer NOT NULL,
	"product_basis_points" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commission_policy_rates_valid" CHECK ("commission_policy"."service_basis_points" between 0 and 10000 and "commission_policy"."product_basis_points" between 0 and 10000 and "commission_policy"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "checkout" ADD COLUMN "staff_id" uuid;--> statement-breakpoint
ALTER TABLE "checkout_line" ADD COLUMN "discount_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "checkout_line" ADD COLUMN "tax_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "commission_accrual" ADD CONSTRAINT "commission_accrual_staff_id_staff_profile_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_accrual" ADD CONSTRAINT "commission_accrual_checkout_id_checkout_id_fk" FOREIGN KEY ("checkout_id") REFERENCES "public"."checkout"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_accrual" ADD CONSTRAINT "commission_accrual_checkout_line_id_checkout_line_id_fk" FOREIGN KEY ("checkout_line_id") REFERENCES "public"."checkout_line"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_payout" ADD CONSTRAINT "commission_payout_staff_id_staff_profile_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_payout" ADD CONSTRAINT "commission_payout_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_policy" ADD CONSTRAINT "commission_policy_staff_id_staff_profile_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commission_accrual_staff_created_idx" ON "commission_accrual" USING btree ("staff_id","created_at");--> statement-breakpoint
CREATE INDEX "commission_payout_staff_created_idx" ON "commission_payout" USING btree ("staff_id","created_at");--> statement-breakpoint
ALTER TABLE "checkout" ADD CONSTRAINT "checkout_staff_id_staff_profile_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff_profile"("id") ON DELETE no action ON UPDATE no action;