CREATE TABLE "appointment_series" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"timezone" text NOT NULL,
	"cadence" text NOT NULL,
	"interval" integer NOT NULL,
	"occurrence_count" integer NOT NULL,
	"created_by" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointment_series_actor_key_unique" UNIQUE("created_by","idempotency_key"),
	CONSTRAINT "appointment_series_terms_valid" CHECK ("appointment_series"."cadence" in ('weekly','monthly') and "appointment_series"."interval" between 1 and 12 and "appointment_series"."occurrence_count" between 2 and 12)
);
--> statement-breakpoint
CREATE TABLE "appointment_series_visit" (
	"series_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"appointment_id" uuid NOT NULL,
	CONSTRAINT "appointment_series_visit_series_id_position_pk" PRIMARY KEY("series_id","position"),
	CONSTRAINT "appointment_series_visit_appointmentId_unique" UNIQUE("appointment_id"),
	CONSTRAINT "appointment_series_position_valid" CHECK ("appointment_series_visit"."position" between 0 and 11)
);
--> statement-breakpoint
ALTER TABLE "appointment_series" ADD CONSTRAINT "appointment_series_client_id_client_profile_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_series" ADD CONSTRAINT "appointment_series_staff_id_staff_profile_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_series" ADD CONSTRAINT "appointment_series_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_series_visit" ADD CONSTRAINT "appointment_series_visit_series_id_appointment_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."appointment_series"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_series_visit" ADD CONSTRAINT "appointment_series_visit_appointment_id_appointment_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointment"("id") ON DELETE no action ON UPDATE no action;