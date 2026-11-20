CREATE TABLE "staff_portrait" (
	"staff_id" uuid PRIMARY KEY NOT NULL,
	"version" uuid NOT NULL,
	"image" "bytea" NOT NULL
);
--> statement-breakpoint
ALTER TABLE "staff_portrait" ADD CONSTRAINT "staff_portrait_staff_id_staff_profile_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff_profile"("id") ON DELETE cascade ON UPDATE no action;