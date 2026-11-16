CREATE TABLE "waitlist_entry" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"staff_id" uuid,
	"service_ids" uuid[] NOT NULL,
	"service_names" text[] NOT NULL,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"from_time" text NOT NULL,
	"to_time" text NOT NULL,
	"timezone" text NOT NULL,
	"state" text DEFAULT 'waiting' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"selection_hash" text NOT NULL,
	"request_hash" text NOT NULL,
	"created_by" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"not_before" timestamp with time zone NOT NULL,
	"last_scanned_at" timestamp with time zone,
	"appointment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "waitlist_entry_actor_key_unique" UNIQUE("created_by","idempotency_key"),
	CONSTRAINT "waitlist_entry_valid" CHECK ("waitlist_entry"."version">0 and "waitlist_entry"."state" in ('waiting','offered','booked','cancelled','expired','unavailable') and "waitlist_entry"."to_date">="waitlist_entry"."from_date" and "waitlist_entry"."to_date"-"waitlist_entry"."from_date"<30 and "waitlist_entry"."from_time"~'^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' and "waitlist_entry"."to_time"~'^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' and "waitlist_entry"."from_time"<"waitlist_entry"."to_time" and cardinality("waitlist_entry"."service_ids") between 1 and 8)
);
--> statement-breakpoint
CREATE TABLE "waitlist_offer" (
	"id" uuid PRIMARY KEY NOT NULL,
	"entry_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'offered' NOT NULL,
	"services" jsonb NOT NULL,
	"policy" jsonb NOT NULL,
	"catalog_hash" text NOT NULL,
	"price_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"accepted_by" text,
	"accept_key" text,
	"accept_hash" text,
	"appointment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "waitlist_offer_valid" CHECK ("waitlist_offer"."ends_at">"waitlist_offer"."starts_at" and "waitlist_offer"."expires_at"<="waitlist_offer"."starts_at" and "waitlist_offer"."price_cents" between 0 and 999999999 and "waitlist_offer"."state" in ('offered','accepted','expired','declined','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "waitlist_policy" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"terms" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "waitlist_policy_singleton" CHECK ("waitlist_policy"."id"=1 and "waitlist_policy"."version">0)
);
--> statement-breakpoint
ALTER TABLE "waitlist_entry" ADD CONSTRAINT "waitlist_entry_client_id_client_profile_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entry" ADD CONSTRAINT "waitlist_entry_staff_id_staff_profile_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entry" ADD CONSTRAINT "waitlist_entry_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entry" ADD CONSTRAINT "waitlist_entry_appointment_id_appointment_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_offer" ADD CONSTRAINT "waitlist_offer_entry_id_waitlist_entry_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."waitlist_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_offer" ADD CONSTRAINT "waitlist_offer_staff_id_staff_profile_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_offer" ADD CONSTRAINT "waitlist_offer_accepted_by_user_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_offer" ADD CONSTRAINT "waitlist_offer_appointment_id_appointment_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "waitlist_entry_active_selection_unique" ON "waitlist_entry" USING btree ("client_id","selection_hash") WHERE "waitlist_entry"."state" in ('waiting','offered');--> statement-breakpoint
CREATE INDEX "waitlist_entry_customer_idx" ON "waitlist_entry" USING btree ("client_id","created_at");--> statement-breakpoint
CREATE INDEX "waitlist_entry_pending_idx" ON "waitlist_entry" USING btree ("last_scanned_at","created_at") WHERE "waitlist_entry"."state"='waiting';--> statement-breakpoint
CREATE UNIQUE INDEX "waitlist_offer_active_entry_unique" ON "waitlist_offer" USING btree ("entry_id") WHERE "waitlist_offer"."state"='offered';--> statement-breakpoint
CREATE INDEX "waitlist_offer_expiry_idx" ON "waitlist_offer" USING btree ("expires_at") WHERE "waitlist_offer"."state"='offered';--> statement-breakpoint
CREATE INDEX "waitlist_offer_staff_time_idx" ON "waitlist_offer" USING btree ("staff_id","starts_at");--> statement-breakpoint
ALTER TABLE "waitlist_offer" ADD CONSTRAINT "waitlist_offer_no_overlap" EXCLUDE USING gist ("staff_id" WITH =, tstzrange("starts_at", "ends_at", '[)') WITH &&) WHERE (state = 'offered');
