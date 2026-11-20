CREATE TABLE "calendar_notice_archive" (
	"user_id" text NOT NULL,
	"audit_id" uuid NOT NULL,
	"archived_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_notice_archive_user_id_audit_id_pk" PRIMARY KEY("user_id","audit_id")
);
--> statement-breakpoint
ALTER TABLE "calendar_notice_archive" ADD CONSTRAINT "calendar_notice_archive_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_notice_archive" ADD CONSTRAINT "calendar_notice_archive_audit_id_audit_log_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."audit_log"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_action_created_idx" ON "audit_log" USING btree ("action","created_at","id");