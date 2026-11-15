CREATE TYPE "public"."gift_card_status" AS ENUM('pending', 'active', 'void');--> statement-breakpoint
CREATE TABLE "gift_card" (
	"id" uuid PRIMARY KEY NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"buyer_client_id" uuid,
	"amount_cents" integer NOT NULL,
	"balance_cents" integer DEFAULT 0 NOT NULL,
	"reserved_cents" integer DEFAULT 0 NOT NULL,
	"purchase_refunded_cents" integer DEFAULT 0 NOT NULL,
	"status" "gift_card_status" DEFAULT 'pending' NOT NULL,
	"code_hash" text NOT NULL,
	"code_nonce" text NOT NULL,
	"code_last4" text NOT NULL,
	"expires_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gift_card_codeHash_unique" UNIQUE("code_hash"),
	CONSTRAINT "gift_card_actor_key_unique" UNIQUE("created_by","idempotency_key"),
	CONSTRAINT "gift_card_value_valid" CHECK ("gift_card"."amount_cents" between 1 and 999999999 and "gift_card"."balance_cents" between 0 and "gift_card"."amount_cents" and "gift_card"."reserved_cents" between 0 and "gift_card"."balance_cents" and "gift_card"."purchase_refunded_cents" between 0 and "gift_card"."amount_cents" and "gift_card"."version" > 0 and length("gift_card"."code_last4") = 4)
);
--> statement-breakpoint
CREATE TABLE "gift_card_movement" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gift_card_id" uuid NOT NULL,
	"checkout_id" uuid NOT NULL,
	"payment_id" uuid,
	"refund_id" uuid,
	"kind" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"event_key" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gift_card_movement_event_unique" UNIQUE("gift_card_id","event_key"),
	CONSTRAINT "gift_card_movement_kind_valid" CHECK ("gift_card_movement"."kind" in ('activation', 'redemption', 'redemption_refund', 'purchase_refund', 'purchase_refund_reversal')),
	CONSTRAINT "gift_card_movement_amount_valid" CHECK ("gift_card_movement"."amount_cents" between -999999999 and 999999999 and "gift_card_movement"."amount_cents" <> 0)
);
--> statement-breakpoint
ALTER TABLE "checkout_line" ADD COLUMN "gift_card_id" uuid;--> statement-breakpoint
ALTER TABLE "checkout_payment" ADD COLUMN "gift_card_id" uuid;--> statement-breakpoint
ALTER TABLE "gift_card" ADD CONSTRAINT "gift_card_buyer_client_id_client_profile_id_fk" FOREIGN KEY ("buyer_client_id") REFERENCES "public"."client_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card" ADD CONSTRAINT "gift_card_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_movement" ADD CONSTRAINT "gift_card_movement_gift_card_id_gift_card_id_fk" FOREIGN KEY ("gift_card_id") REFERENCES "public"."gift_card"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_movement" ADD CONSTRAINT "gift_card_movement_checkout_id_checkout_id_fk" FOREIGN KEY ("checkout_id") REFERENCES "public"."checkout"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_movement" ADD CONSTRAINT "gift_card_movement_payment_id_checkout_payment_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."checkout_payment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_movement" ADD CONSTRAINT "gift_card_movement_refund_id_checkout_refund_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."checkout_refund"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_movement" ADD CONSTRAINT "gift_card_movement_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gift_card_buyer_created_idx" ON "gift_card" USING btree ("buyer_client_id","created_at");--> statement-breakpoint
CREATE INDEX "gift_card_movement_created_idx" ON "gift_card_movement" USING btree ("gift_card_id","created_at");--> statement-breakpoint
ALTER TABLE "checkout_line" ADD CONSTRAINT "checkout_line_gift_card_id_gift_card_id_fk" FOREIGN KEY ("gift_card_id") REFERENCES "public"."gift_card"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_payment" ADD CONSTRAINT "checkout_payment_gift_card_id_gift_card_id_fk" FOREIGN KEY ("gift_card_id") REFERENCES "public"."gift_card"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_line" ADD CONSTRAINT "checkout_line_giftCardId_unique" UNIQUE("gift_card_id");