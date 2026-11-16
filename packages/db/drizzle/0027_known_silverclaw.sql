CREATE TABLE "client_import" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_by" text,
	"idempotency_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"client_ids" uuid[] NOT NULL,
	"skipped" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_import_actor_key_unique" UNIQUE("created_by","idempotency_key"),
	CONSTRAINT "client_import_valid" CHECK (cardinality("client_import"."client_ids") between 1 and 500 and "client_import"."skipped">=0 and "client_import"."request_fingerprint" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "client_import" ADD CONSTRAINT "client_import_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;