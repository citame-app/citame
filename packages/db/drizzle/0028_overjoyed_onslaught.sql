CREATE TABLE "client_photo" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"caption" text NOT NULL,
	"captured_on" date,
	"image" "bytea",
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"bytes" integer NOT NULL,
	"permission_version" text NOT NULL,
	"created_by" text,
	"idempotency_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "client_photo_actor_key_unique" UNIQUE("created_by","idempotency_key"),
	CONSTRAINT "client_photo_valid" CHECK ("client_photo"."width" between 1 and 1024 and "client_photo"."height" between 1 and 1024 and "client_photo"."bytes" between 1 and 262144 and "client_photo"."version">0 and length(btrim("client_photo"."caption")) between 1 and 300 and "client_photo"."request_fingerprint" ~ '^[a-f0-9]{64}$' and (("client_photo"."deleted_at" is null and "client_photo"."image" is not null and octet_length("client_photo"."image")="client_photo"."bytes") or ("client_photo"."deleted_at" is not null and "client_photo"."image" is null)))
);
--> statement-breakpoint
ALTER TABLE "client_photo" ADD CONSTRAINT "client_photo_client_id_client_profile_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client_profile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_photo" ADD CONSTRAINT "client_photo_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "client_photo_active_client_idx" ON "client_photo" USING btree ("client_id","created_at") WHERE "client_photo"."deleted_at" is null;