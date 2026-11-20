CREATE TABLE "desktop_device" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"grant_id" text NOT NULL,
	"enrollment_id" text NOT NULL,
	"public_key" text NOT NULL,
	"label" text NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "desktop_device_enrollmentId_unique" UNIQUE("enrollment_id")
);
--> statement-breakpoint
ALTER TABLE "desktop_device" ADD CONSTRAINT "desktop_device_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desktop_device" ADD CONSTRAINT "desktop_device_grant_id_oauth_consent_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."oauth_consent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "desktop_device_user_idx" ON "desktop_device" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "desktop_device_grant_idx" ON "desktop_device" USING btree ("grant_id");