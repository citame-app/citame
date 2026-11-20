ALTER TABLE "appointment_service" ADD COLUMN "price_type" text DEFAULT 'fixed' NOT NULL;--> statement-breakpoint
ALTER TABLE "checkout" ADD COLUMN "pricing_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "checkout_line" ADD COLUMN "price_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "checkout_line" ADD COLUMN "minimum_unit_amount_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "price_type" text DEFAULT 'fixed' NOT NULL;--> statement-breakpoint
ALTER TABLE "appointment_service" ADD CONSTRAINT "appointment_service_price_type_valid" CHECK ("appointment_service"."price_type" in ('fixed','variable','hidden','free','from') and ("appointment_service"."price_type" not in ('variable','free') or "appointment_service"."price_cents"=0));--> statement-breakpoint
ALTER TABLE "checkout_line" ADD CONSTRAINT "checkout_line_price_minimum" CHECK ("checkout_line"."minimum_unit_amount_cents" between 0 and "checkout_line"."unit_amount_cents" and (not "checkout_line"."price_pending" or "checkout_line"."kind"='service'));--> statement-breakpoint
ALTER TABLE "service" ADD CONSTRAINT "service_price_type_valid" CHECK ("service"."price_type" in ('fixed','variable','hidden','free','from') and ("service"."price_type" not in ('variable','free') or "service"."price_cents"=0));