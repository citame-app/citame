CREATE TABLE "retail_product_photo" (
	"product_id" uuid PRIMARY KEY NOT NULL,
	"version" uuid NOT NULL,
	"image" "bytea" NOT NULL,
	CONSTRAINT "retail_product_photo_size" CHECK (octet_length("retail_product_photo"."image") between 1 and 262144)
);
--> statement-breakpoint
ALTER TABLE "retail_product_photo" ADD CONSTRAINT "retail_product_photo_product_id_retail_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."retail_product"("id") ON DELETE cascade ON UPDATE no action;