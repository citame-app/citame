CREATE TABLE "marketing_campaign" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"channel" text NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"email_body" text DEFAULT '' NOT NULL,
	"sms_body" text DEFAULT '' NOT NULL,
	"audience" jsonb DEFAULT '{"tags":[],"inactiveDays":null,"noFutureAppointments":false}'::jsonb NOT NULL,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"delay_minutes" integer DEFAULT 120 NOT NULL,
	"birthday_lead_days" integer DEFAULT 7 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"scheduled_for" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"created_by" text,
	"request_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marketing_campaign_valid" CHECK ("marketing_campaign"."channel" in ('email','sms','optimized') and "marketing_campaign"."trigger" in ('manual','first_visit','inactive','birthday') and "marketing_campaign"."status" in ('draft','scheduled','active','completed','cancelled') and "marketing_campaign"."version">0 and "marketing_campaign"."delay_minutes" between 0 and 525600 and "marketing_campaign"."birthday_lead_days" between 0 and 30)
);
--> statement-breakpoint
CREATE TABLE "marketing_consent" (
	"client_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"enabled" boolean NOT NULL,
	"source" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"recorded_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marketing_consent_client_id_channel_pk" PRIMARY KEY("client_id","channel"),
	CONSTRAINT "marketing_consent_valid" CHECK ("marketing_consent"."channel" in ('email','sms') and "marketing_consent"."version">0)
);
--> statement-breakpoint
CREATE TABLE "marketing_delivery" (
	"id" uuid PRIMARY KEY NOT NULL,
	"campaign_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"occurrence" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"locked_by" text,
	"locked_until" timestamp with time zone,
	"reason" text,
	"provider_message_id" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marketing_delivery_occurrence_unique" UNIQUE("campaign_id","client_id","occurrence"),
	CONSTRAINT "marketing_delivery_valid" CHECK ("marketing_delivery"."channel" in ('email','sms') and "marketing_delivery"."status" in ('pending','processing','sent','skipped','failed','unknown','cancelled'))
);
--> statement-breakpoint
ALTER TABLE "marketing_campaign" ADD CONSTRAINT "marketing_campaign_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_consent" ADD CONSTRAINT "marketing_consent_client_id_client_profile_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client_profile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_consent" ADD CONSTRAINT "marketing_consent_recorded_by_user_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_delivery" ADD CONSTRAINT "marketing_delivery_campaign_id_marketing_campaign_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."marketing_campaign"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_delivery" ADD CONSTRAINT "marketing_delivery_client_id_client_profile_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "marketing_campaign_schedule_idx" ON "marketing_campaign" USING btree ("status","scheduled_for");--> statement-breakpoint
CREATE INDEX "marketing_delivery_due_idx" ON "marketing_delivery" USING btree ("status","scheduled_for");--> statement-breakpoint
CREATE INDEX "marketing_delivery_campaign_idx" ON "marketing_delivery" USING btree ("campaign_id","created_at","id");