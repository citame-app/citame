CREATE TABLE "appointment_visit" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"created_by" text NOT NULL,
	"request_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "appointment_visit_part" (
	"visit_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"appointment_id" uuid NOT NULL,
	CONSTRAINT "appointment_visit_part_visit_id_position_pk" PRIMARY KEY("visit_id","position"),
	CONSTRAINT "appointment_visit_part_appointmentId_unique" UNIQUE("appointment_id"),
	CONSTRAINT "appointment_visit_position_valid" CHECK ("appointment_visit_part"."position" between 0 and 7)
);
--> statement-breakpoint
ALTER TABLE "appointment_visit" ADD CONSTRAINT "appointment_visit_client_id_client_profile_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_visit" ADD CONSTRAINT "appointment_visit_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_visit_part" ADD CONSTRAINT "appointment_visit_part_visit_id_appointment_visit_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."appointment_visit"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_visit_part" ADD CONSTRAINT "appointment_visit_part_appointment_id_appointment_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointment"("id") ON DELETE no action ON UPDATE no action;