CREATE TABLE "waitlist_source_entry" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"requested_date" date NOT NULL,
	"duration_minutes" integer NOT NULL,
	"flexible" boolean NOT NULL,
	"source_order" integer NOT NULL,
	"source_hash" text NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"linked_entry_id" uuid,
	CONSTRAINT "waitlist_source_entry_valid" CHECK ("waitlist_source_entry"."duration_minutes">0 and "waitlist_source_entry"."source_order">=0)
);
--> statement-breakpoint
ALTER TABLE "waitlist_source_entry" ADD CONSTRAINT "waitlist_source_entry_client_id_client_profile_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_source_entry" ADD CONSTRAINT "waitlist_source_entry_linked_entry_id_waitlist_entry_id_fk" FOREIGN KEY ("linked_entry_id") REFERENCES "public"."waitlist_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "waitlist_source_entry_queue_idx" ON "waitlist_source_entry" USING btree ("requested_date","source_order") WHERE "waitlist_source_entry"."linked_entry_id" is null;