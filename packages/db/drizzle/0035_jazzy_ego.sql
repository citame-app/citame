CREATE TABLE "service_combination" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"service_ids" uuid[] NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"request_fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_combination_valid" CHECK ("service_combination"."version">0 and cardinality("service_combination"."service_ids") between 2 and 24 and length(btrim("service_combination"."name")) between 1 and 120 and "service_combination"."request_fingerprint" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "service_combination" ADD CONSTRAINT "service_combination_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;