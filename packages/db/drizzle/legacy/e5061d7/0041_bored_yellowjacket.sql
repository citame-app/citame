ALTER TABLE "service" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "online_booking" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "client_instructions" text;--> statement-breakpoint
ALTER TABLE "service" ADD CONSTRAINT "service_category_valid" CHECK ("service"."category" is null or (length(trim("service"."category")) between 1 and 80 and "service"."category"=trim("service"."category")));--> statement-breakpoint
ALTER TABLE "service" ADD CONSTRAINT "service_sort_order_valid" CHECK ("service"."sort_order" between 0 and 100000);--> statement-breakpoint
ALTER TABLE "service" ADD CONSTRAINT "service_instructions_valid" CHECK ("service"."client_instructions" is null or length("service"."client_instructions")<=2000);