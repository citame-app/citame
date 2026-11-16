CREATE TABLE "resource_pool" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"capacity" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	CONSTRAINT "resource_pool_actor_key_unique" UNIQUE("created_by","idempotency_key"),
	CONSTRAINT "resource_pool_valid" CHECK ("resource_pool"."capacity" between 1 and 20 and "resource_pool"."version">0 and "resource_pool"."kind" in ('room','equipment','station','other') and length("resource_pool"."name") between 1 and 80)
);
--> statement-breakpoint
CREATE TABLE "resource_reservation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"resource_id" uuid NOT NULL,
	"appointment_id" uuid,
	"offer_id" uuid,
	"service_position" integer NOT NULL,
	"unit_index" integer NOT NULL,
	"offset_minutes" integer NOT NULL,
	"end_offset_minutes" integer NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resource_reservation_valid" CHECK (num_nonnulls("resource_reservation"."appointment_id","resource_reservation"."offer_id")=1 and "resource_reservation"."service_position">=0 and "resource_reservation"."unit_index" between 0 and 19 and "resource_reservation"."offset_minutes">=0 and "resource_reservation"."end_offset_minutes">"resource_reservation"."offset_minutes" and "resource_reservation"."end_offset_minutes"<=100000 and "resource_reservation"."ends_at">"resource_reservation"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "service_resource" (
	"id" uuid PRIMARY KEY NOT NULL,
	"service_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	CONSTRAINT "service_resource_unique" UNIQUE("service_id","resource_id"),
	CONSTRAINT "service_resource_quantity_valid" CHECK ("service_resource"."quantity" between 1 and 20)
);
--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "resource_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "resource_pool" ADD CONSTRAINT "resource_pool_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_reservation" ADD CONSTRAINT "resource_reservation_resource_id_resource_pool_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resource_pool"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_reservation" ADD CONSTRAINT "resource_reservation_appointment_id_appointment_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_reservation" ADD CONSTRAINT "resource_reservation_offer_id_waitlist_offer_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."waitlist_offer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_resource" ADD CONSTRAINT "service_resource_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_resource" ADD CONSTRAINT "service_resource_resource_id_resource_pool_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resource_pool"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "resource_pool_active_name_unique" ON "resource_pool" USING btree (lower("name")) WHERE "resource_pool"."active";--> statement-breakpoint
CREATE INDEX "resource_reservation_appointment_idx" ON "resource_reservation" USING btree ("appointment_id");--> statement-breakpoint
CREATE INDEX "resource_reservation_offer_idx" ON "resource_reservation" USING btree ("offer_id");--> statement-breakpoint
CREATE INDEX "resource_reservation_pool_time_idx" ON "resource_reservation" USING btree ("resource_id","starts_at") WHERE "resource_reservation"."active";