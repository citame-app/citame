ALTER TABLE "retail_product" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "retail_product" ADD COLUMN "brand" text;--> statement-breakpoint
ALTER TABLE "retail_product" ADD COLUMN "resellable" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "retail_product" ADD COLUMN "target_stock" integer;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "color" text;--> statement-breakpoint
ALTER TABLE "retail_product" ADD CONSTRAINT "retail_product_target_valid" CHECK ("retail_product"."target_stock" is null or "retail_product"."target_stock" between 0 and 999999999);