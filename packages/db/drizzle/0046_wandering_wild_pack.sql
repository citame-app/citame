CREATE TABLE "appointment_context" (
	"id" uuid PRIMARY KEY NOT NULL,
	"appointment_id" uuid NOT NULL,
	"service_position" integer NOT NULL,
	"requested_staff_id" uuid,
	"internal_note" text,
	"customer_comment" text,
	"invoiced" boolean,
	"paid" boolean,
	"source" text DEFAULT 'citame' NOT NULL,
	"source_ref" text,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointment_context_position_unique" UNIQUE("appointment_id","service_position"),
	CONSTRAINT "appointment_context_source_unique" UNIQUE("source","source_ref"),
	CONSTRAINT "appointment_context_position_valid" CHECK ("appointment_context"."service_position" between 0 and 23),
	CONSTRAINT "appointment_context_source_valid" CHECK ("appointment_context"."source" in ('citame','booksy'))
);
--> statement-breakpoint
ALTER TABLE "appointment" ADD COLUMN "requested_staff_id" uuid;--> statement-breakpoint
ALTER TABLE "appointment" ADD COLUMN "customer_comment" text;--> statement-breakpoint
ALTER TABLE "appointment_context" ADD CONSTRAINT "appointment_context_appointment_id_appointment_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_context" ADD CONSTRAINT "appointment_context_requested_staff_id_staff_profile_id_fk" FOREIGN KEY ("requested_staff_id") REFERENCES "public"."staff_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_requested_staff_id_staff_profile_id_fk" FOREIGN KEY ("requested_staff_id") REFERENCES "public"."staff_profile"("id") ON DELETE no action ON UPDATE no action;