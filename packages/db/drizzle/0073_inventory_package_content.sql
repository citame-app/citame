ALTER TABLE "retail_product" ADD COLUMN "package_content_quantity" numeric;--> statement-breakpoint
ALTER TABLE "retail_product" ADD COLUMN "package_content_unit" text;--> statement-breakpoint
ALTER TABLE "retail_product" ADD CONSTRAINT "retail_product_package_content_valid" CHECK (("retail_product"."package_content_quantity" is null and "retail_product"."package_content_unit" is null) or
          ("retail_product"."package_content_quantity" is not null and "retail_product"."package_content_unit" is not null and
           "retail_product"."package_content_quantity" > 0 and "retail_product"."package_content_quantity" <= 999999999.999 and
           scale("retail_product"."package_content_quantity") <= 3 and length(btrim("retail_product"."package_content_unit")) between 1 and 20));