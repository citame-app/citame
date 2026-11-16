ALTER TYPE "public"."payment_method" ADD VALUE 'package';--> statement-breakpoint
ALTER TYPE "public"."payment_method" ADD VALUE 'membership';--> statement-breakpoint
CREATE TABLE "benefit_plan" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"kind" text NOT NULL,
	"price_cents" integer NOT NULL,
	"tax_basis_points" integer DEFAULT 0 NOT NULL,
	"included_uses" integer NOT NULL,
	"discount_basis_points" integer DEFAULT 0 NOT NULL,
	"service_ids" uuid[] NOT NULL,
	"validity_days" integer,
	"period_months" integer,
	"active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "benefit_plan_actor_key_unique" UNIQUE("created_by","idempotency_key"),
	CONSTRAINT "benefit_plan_valid" CHECK ("benefit_plan"."price_cents" between 1 and 999999999 and "benefit_plan"."included_uses" between 0 and 1000 and "benefit_plan"."price_cents" >= "benefit_plan"."included_uses" and "benefit_plan"."tax_basis_points" between 0 and 10000 and "benefit_plan"."discount_basis_points" between 0 and 10000 and cardinality("benefit_plan"."service_ids") between 1 and 100 and "benefit_plan"."version">0 and (("benefit_plan"."kind"='package' and "benefit_plan"."included_uses">0 and "benefit_plan"."period_months" is null and "benefit_plan"."discount_basis_points"=0 and ("benefit_plan"."validity_days" is null or "benefit_plan"."validity_days" between 1 and 3650)) or ("benefit_plan"."kind"='membership' and "benefit_plan"."period_months" between 1 and 12 and "benefit_plan"."validity_days" is null and ("benefit_plan"."included_uses">0 or "benefit_plan"."discount_basis_points">0))))
);
--> statement-breakpoint
CREATE TABLE "pass_contract" (
	"id" uuid PRIMARY KEY NOT NULL,
	"plan_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"price_cents" integer NOT NULL,
	"tax_basis_points" integer NOT NULL,
	"included_uses" integer NOT NULL,
	"discount_basis_points" integer NOT NULL,
	"service_ids" uuid[] NOT NULL,
	"validity_days" integer,
	"period_months" integer,
	"timezone" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"renewal_mode" text DEFAULT 'manual' NOT NULL,
	"auto_pay_ready" boolean DEFAULT false NOT NULL,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"anchor_at" timestamp with time zone,
	"consent" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pass_contract_actor_key_unique" UNIQUE("created_by","idempotency_key"),
	CONSTRAINT "pass_contract_valid" CHECK ("pass_contract"."status" in ('pending','active','cancelled','void') and "pass_contract"."renewal_mode" in ('manual','automatic') and "pass_contract"."price_cents" between 1 and 999999999 and "pass_contract"."included_uses" between 0 and 1000 and "pass_contract"."price_cents">="pass_contract"."included_uses" and "pass_contract"."discount_basis_points" between 0 and 10000 and "pass_contract"."tax_basis_points" between 0 and 10000 and "pass_contract"."version">0)
);
--> statement-breakpoint
CREATE TABLE "pass_period" (
	"id" uuid PRIMARY KEY NOT NULL,
	"contract_id" uuid NOT NULL,
	"index" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"price_cents" integer NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pass_period_contract_index_unique" UNIQUE("contract_id","index"),
	CONSTRAINT "pass_period_valid" CHECK ("pass_period"."status" in ('pending','active','void') and "pass_period"."index" between 0 and 10000 and "pass_period"."price_cents" between 1 and 999999999 and "pass_period"."version">0 and ("pass_period"."ends_at" is null or "pass_period"."ends_at">"pass_period"."starts_at"))
);
--> statement-breakpoint
CREATE TABLE "pass_redemption" (
	"id" uuid PRIMARY KEY NOT NULL,
	"unit_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"checkout_id" uuid NOT NULL,
	"checkout_line_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"allocated_cents" integer NOT NULL,
	"tax_cents" integer NOT NULL,
	"refunded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pass_redemption_paymentId_unique" UNIQUE("payment_id"),
	CONSTRAINT "pass_redemption_money_valid" CHECK ("pass_redemption"."amount_cents">0 and "pass_redemption"."allocated_cents">0 and "pass_redemption"."tax_cents" between 0 and "pass_redemption"."allocated_cents")
);
--> statement-breakpoint
CREATE TABLE "pass_refund_allocation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"period_id" uuid NOT NULL,
	"refund_id" uuid NOT NULL,
	"unit_ids" uuid[] NOT NULL,
	"excess_cents" integer NOT NULL,
	"status" text DEFAULT 'held' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pass_refund_allocation_refundId_unique" UNIQUE("refund_id"),
	CONSTRAINT "pass_refund_allocation_valid" CHECK ("pass_refund_allocation"."excess_cents">=0 and "pass_refund_allocation"."status" in ('held','applied','released'))
);
--> statement-breakpoint
CREATE TABLE "pass_unit" (
	"id" uuid PRIMARY KEY NOT NULL,
	"period_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"allocated_cents" integer NOT NULL,
	"tax_cents" integer NOT NULL,
	"status" text DEFAULT 'available' NOT NULL,
	"payment_id" uuid,
	"refund_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pass_unit_period_ordinal_unique" UNIQUE("period_id","ordinal"),
	CONSTRAINT "pass_unit_valid" CHECK ("pass_unit"."status" in ('available','used','held','retired') and "pass_unit"."ordinal">=0 and "pass_unit"."allocated_cents" between 1 and 999999999 and "pass_unit"."tax_cents" between 0 and "pass_unit"."allocated_cents")
);
--> statement-breakpoint
ALTER TABLE "checkout_line" ADD COLUMN "pass_period_id" uuid;--> statement-breakpoint
ALTER TABLE "checkout_line" ADD COLUMN "membership_period_id" uuid;--> statement-breakpoint
ALTER TABLE "benefit_plan" ADD CONSTRAINT "benefit_plan_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pass_contract" ADD CONSTRAINT "pass_contract_plan_id_benefit_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."benefit_plan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pass_contract" ADD CONSTRAINT "pass_contract_client_id_client_profile_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pass_contract" ADD CONSTRAINT "pass_contract_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pass_period" ADD CONSTRAINT "pass_period_contract_id_pass_contract_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."pass_contract"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pass_redemption" ADD CONSTRAINT "pass_redemption_unit_id_pass_unit_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."pass_unit"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pass_redemption" ADD CONSTRAINT "pass_redemption_period_id_pass_period_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."pass_period"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pass_redemption" ADD CONSTRAINT "pass_redemption_checkout_id_checkout_id_fk" FOREIGN KEY ("checkout_id") REFERENCES "public"."checkout"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pass_redemption" ADD CONSTRAINT "pass_redemption_checkout_line_id_checkout_line_id_fk" FOREIGN KEY ("checkout_line_id") REFERENCES "public"."checkout_line"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pass_redemption" ADD CONSTRAINT "pass_redemption_payment_id_checkout_payment_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."checkout_payment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pass_refund_allocation" ADD CONSTRAINT "pass_refund_allocation_period_id_pass_period_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."pass_period"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pass_refund_allocation" ADD CONSTRAINT "pass_refund_allocation_refund_id_checkout_refund_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."checkout_refund"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pass_unit" ADD CONSTRAINT "pass_unit_period_id_pass_period_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."pass_period"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pass_unit" ADD CONSTRAINT "pass_unit_payment_id_checkout_payment_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."checkout_payment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pass_unit" ADD CONSTRAINT "pass_unit_refund_id_checkout_refund_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."checkout_refund"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pass_contract_client_idx" ON "pass_contract" USING btree ("client_id","created_at");--> statement-breakpoint
CREATE INDEX "pass_period_ends_idx" ON "pass_period" USING btree ("ends_at");--> statement-breakpoint
CREATE INDEX "pass_redemption_line_idx" ON "pass_redemption" USING btree ("checkout_line_id");--> statement-breakpoint
CREATE INDEX "pass_redemption_period_idx" ON "pass_redemption" USING btree ("period_id");--> statement-breakpoint
ALTER TABLE "checkout_line" ADD CONSTRAINT "checkout_line_pass_period_id_pass_period_id_fk" FOREIGN KEY ("pass_period_id") REFERENCES "public"."pass_period"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_line" ADD CONSTRAINT "checkout_line_membership_period_id_pass_period_id_fk" FOREIGN KEY ("membership_period_id") REFERENCES "public"."pass_period"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_line" ADD CONSTRAINT "checkout_line_passPeriodId_unique" UNIQUE("pass_period_id");