CREATE TYPE "public"."stock_reservation_status" AS ENUM('reserved', 'consumed', 'released');--> statement-breakpoint
CREATE TABLE "retail_product" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"sku" text NOT NULL,
	"barcode" text,
	"description" text,
	"price_cents" integer NOT NULL,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"cost_cents" integer,
	"tax_basis_points" integer DEFAULT 0 NOT NULL,
	"unit_label" text DEFAULT 'unit' NOT NULL,
	"storage_location" text,
	"active" boolean DEFAULT true NOT NULL,
	"stock_on_hand" integer DEFAULT 0 NOT NULL,
	"stock_reserved" integer DEFAULT 0 NOT NULL,
	"low_stock_threshold" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retail_product_sku_unique" UNIQUE("sku"),
	CONSTRAINT "retail_product_barcode_unique" UNIQUE("barcode"),
	CONSTRAINT "retail_product_actor_idempotency_unique" UNIQUE("created_by","idempotency_key"),
	CONSTRAINT "retail_product_stock_valid" CHECK ("retail_product"."stock_on_hand" between 0 and 999999999 and "retail_product"."stock_reserved" between 0 and "retail_product"."stock_on_hand" and "retail_product"."low_stock_threshold" between 0 and 999999999 and "retail_product"."version" > 0),
	CONSTRAINT "retail_product_money_valid" CHECK ("retail_product"."currency" = 'EUR' and "retail_product"."price_cents" between 0 and 999999999 and ("retail_product"."cost_cents" is null or "retail_product"."cost_cents" between 0 and 999999999) and "retail_product"."tax_basis_points" between 0 and 10000),
	CONSTRAINT "retail_product_sku_canonical" CHECK ("retail_product"."sku" = upper("retail_product"."sku"))
);
--> statement-breakpoint
CREATE TABLE "stock_movement" (
	"id" uuid PRIMARY KEY NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity_delta" integer NOT NULL,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"unit_cost_cents" integer,
	"checkout_line_id" uuid,
	"created_by" text,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_movement_idempotency_unique" UNIQUE("product_id","idempotency_key"),
	CONSTRAINT "stock_movement_kind_valid" CHECK ("stock_movement"."kind" in ('opening', 'receive', 'consume', 'count', 'sale', 'return')),
	CONSTRAINT "stock_movement_quantity_valid" CHECK ("stock_movement"."quantity_delta" between -999999999 and 999999999 and ("stock_movement"."quantity_delta" <> 0 or "stock_movement"."kind" in ('opening', 'count'))),
	CONSTRAINT "stock_movement_cost_valid" CHECK ("stock_movement"."unit_cost_cents" is null or "stock_movement"."unit_cost_cents" between 0 and 999999999)
);
--> statement-breakpoint
CREATE TABLE "stock_reservation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"product_id" uuid NOT NULL,
	"checkout_id" uuid NOT NULL,
	"checkout_line_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"status" "stock_reservation_status" DEFAULT 'reserved' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_reservation_checkoutLineId_unique" UNIQUE("checkout_line_id"),
	CONSTRAINT "stock_reservation_quantity_positive" CHECK ("stock_reservation"."quantity" between 1 and 999999999)
);
--> statement-breakpoint
ALTER TABLE "checkout" DROP CONSTRAINT "checkout_appointment_unique";--> statement-breakpoint
ALTER TABLE "checkout" ADD COLUMN "fulfilled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "checkout_line" ADD COLUMN "unit_cost_cents" integer;--> statement-breakpoint
ALTER TABLE "retail_product" ADD CONSTRAINT "retail_product_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_product_id_retail_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."retail_product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_checkout_line_id_checkout_line_id_fk" FOREIGN KEY ("checkout_line_id") REFERENCES "public"."checkout_line"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservation" ADD CONSTRAINT "stock_reservation_product_id_retail_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."retail_product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservation" ADD CONSTRAINT "stock_reservation_checkout_id_checkout_id_fk" FOREIGN KEY ("checkout_id") REFERENCES "public"."checkout"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservation" ADD CONSTRAINT "stock_reservation_checkout_line_id_checkout_line_id_fk" FOREIGN KEY ("checkout_line_id") REFERENCES "public"."checkout_line"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "retail_product_name_idx" ON "retail_product" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_movement_one_sale_per_line" ON "stock_movement" USING btree ("checkout_line_id") WHERE "stock_movement"."kind" = 'sale';--> statement-breakpoint
CREATE INDEX "stock_movement_product_created_idx" ON "stock_movement" USING btree ("product_id","created_at");--> statement-breakpoint
CREATE INDEX "stock_reservation_expiry_idx" ON "stock_reservation" USING btree ("expires_at") WHERE "stock_reservation"."status" = 'reserved';--> statement-breakpoint
CREATE INDEX "stock_reservation_checkout_idx" ON "stock_reservation" USING btree ("checkout_id");--> statement-breakpoint
ALTER TABLE "checkout_line" ADD CONSTRAINT "checkout_line_product_id_retail_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."retail_product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "checkout_active_appointment_unique" ON "checkout" USING btree ("appointment_id") WHERE "checkout"."status" <> 'void';--> statement-breakpoint
-- Existing settled receipts have no retail reservations. Do not retroactively fulfill them.
UPDATE checkout SET fulfilled_at = created_at WHERE status IN ('paid', 'partially_refunded', 'refunded');
