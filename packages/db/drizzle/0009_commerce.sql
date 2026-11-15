CREATE TYPE "public"."checkout_status" AS ENUM('open', 'paid', 'partially_refunded', 'refunded', 'void');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('cash', 'external_card', 'redsys_card', 'redsys_bizum', 'gift_card');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending', 'succeeded', 'failed', 'reconciliation');--> statement-breakpoint
CREATE TYPE "public"."refund_status" AS ENUM('requested', 'dispatched', 'succeeded', 'failed', 'reconciliation');--> statement-breakpoint
CREATE TABLE "cash_movement" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"payment_id" uuid,
	"refund_id" uuid,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cash_movement_idempotency_unique" UNIQUE("session_id","idempotency_key"),
	CONSTRAINT "cash_movement_payment_unique" UNIQUE("payment_id"),
	CONSTRAINT "cash_movement_refund_unique" UNIQUE("refund_id"),
	CONSTRAINT "cash_movement_nonzero" CHECK ("cash_movement"."amount_cents" <> 0)
);
--> statement-breakpoint
CREATE TABLE "cash_session" (
	"id" uuid PRIMARY KEY NOT NULL,
	"opening_cents" integer NOT NULL,
	"opened_by" text,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_by" text,
	"closed_at" timestamp with time zone,
	"counted_cents" integer,
	"expected_cents" integer,
	CONSTRAINT "cash_session_nonnegative" CHECK ("cash_session"."opening_cents" >= 0 and ("cash_session"."counted_cents" is null or "cash_session"."counted_cents" >= 0))
);
--> statement-breakpoint
CREATE TABLE "checkout" (
	"id" uuid PRIMARY KEY NOT NULL,
	"appointment_id" uuid,
	"client_id" uuid,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"status" "checkout_status" DEFAULT 'open' NOT NULL,
	"subtotal_cents" integer NOT NULL,
	"discount_cents" integer DEFAULT 0 NOT NULL,
	"tip_cents" integer DEFAULT 0 NOT NULL,
	"tax_cents" integer DEFAULT 0 NOT NULL,
	"total_cents" integer NOT NULL,
	"created_by" text,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checkout_actor_idempotency_unique" UNIQUE("created_by","idempotency_key"),
	CONSTRAINT "checkout_appointment_unique" UNIQUE("appointment_id"),
	CONSTRAINT "checkout_money_valid" CHECK ("checkout"."currency" = 'EUR' and "checkout"."subtotal_cents" >= 0 and "checkout"."discount_cents" between 0 and "checkout"."subtotal_cents" and "checkout"."tip_cents" >= 0 and "checkout"."tax_cents" >= 0 and "checkout"."total_cents" = "checkout"."subtotal_cents" - "checkout"."discount_cents" + "checkout"."tip_cents" and "checkout"."total_cents" <= 999999999)
);
--> statement-breakpoint
CREATE TABLE "checkout_line" (
	"id" uuid PRIMARY KEY NOT NULL,
	"checkout_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"product_id" uuid,
	"service_id" uuid,
	"description" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_amount_cents" integer NOT NULL,
	"tax_basis_points" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checkout_line_valid" CHECK ("checkout_line"."quantity" between 1 and 1000 and "checkout_line"."unit_amount_cents" between 0 and 999999999 and "checkout_line"."tax_basis_points" between 0 and 10000)
);
--> statement-breakpoint
CREATE TABLE "checkout_payment" (
	"id" uuid PRIMARY KEY NOT NULL,
	"checkout_id" uuid NOT NULL,
	"method" "payment_method" NOT NULL,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"bank_order" text,
	"bank_response" text,
	"authorization_code" text,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"created_by" text,
	"cash_session_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checkout_payment_bankOrder_unique" UNIQUE("bank_order"),
	CONSTRAINT "checkout_payment_idempotency_unique" UNIQUE("checkout_id","idempotency_key"),
	CONSTRAINT "checkout_payment_money_valid" CHECK ("checkout_payment"."amount_cents" between 1 and 999999999 and "checkout_payment"."currency" = 'EUR')
);
--> statement-breakpoint
CREATE TABLE "checkout_refund" (
	"id" uuid PRIMARY KEY NOT NULL,
	"payment_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"status" "refund_status" DEFAULT 'requested' NOT NULL,
	"reason" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checkout_refund_idempotency_unique" UNIQUE("payment_id","idempotency_key"),
	CONSTRAINT "checkout_refund_amount_positive" CHECK ("checkout_refund"."amount_cents" between 1 and 999999999)
);
--> statement-breakpoint
ALTER TABLE "cash_movement" ADD CONSTRAINT "cash_movement_session_id_cash_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."cash_session"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movement" ADD CONSTRAINT "cash_movement_payment_id_checkout_payment_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."checkout_payment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movement" ADD CONSTRAINT "cash_movement_refund_id_checkout_refund_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."checkout_refund"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movement" ADD CONSTRAINT "cash_movement_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_session" ADD CONSTRAINT "cash_session_opened_by_user_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_session" ADD CONSTRAINT "cash_session_closed_by_user_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout" ADD CONSTRAINT "checkout_appointment_id_appointment_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout" ADD CONSTRAINT "checkout_client_id_client_profile_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout" ADD CONSTRAINT "checkout_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_line" ADD CONSTRAINT "checkout_line_checkout_id_checkout_id_fk" FOREIGN KEY ("checkout_id") REFERENCES "public"."checkout"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_payment" ADD CONSTRAINT "checkout_payment_checkout_id_checkout_id_fk" FOREIGN KEY ("checkout_id") REFERENCES "public"."checkout"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_payment" ADD CONSTRAINT "checkout_payment_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_payment" ADD CONSTRAINT "checkout_payment_cash_session_id_cash_session_id_fk" FOREIGN KEY ("cash_session_id") REFERENCES "public"."cash_session"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_refund" ADD CONSTRAINT "checkout_refund_payment_id_checkout_payment_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."checkout_payment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_refund" ADD CONSTRAINT "checkout_refund_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cash_session_one_open" ON "cash_session" USING btree ((true)) WHERE "cash_session"."closed_at" is null;--> statement-breakpoint
CREATE INDEX "checkout_client_idx" ON "checkout" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "checkout_created_idx" ON "checkout" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "checkout_line_checkout_idx" ON "checkout_line" USING btree ("checkout_id");--> statement-breakpoint
CREATE INDEX "checkout_payment_checkout_idx" ON "checkout_payment" USING btree ("checkout_id");--> statement-breakpoint
CREATE INDEX "checkout_refund_payment_idx" ON "checkout_refund" USING btree ("payment_id");