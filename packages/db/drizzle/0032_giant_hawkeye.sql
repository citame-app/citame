CREATE TABLE "review" (
	"id" uuid PRIMARY KEY NOT NULL,
	"appointment_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"created_by" text,
	"idempotency_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"public_name" text,
	"rating" integer,
	"body" text,
	"share_services" boolean DEFAULT false NOT NULL,
	"services" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"moderation_reason" text,
	"reply" text,
	"publication_version" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_appointment_unique" UNIQUE("appointment_id"),
	CONSTRAINT "review_actor_key_unique" UNIQUE("created_by","idempotency_key"),
	CONSTRAINT "review_valid" CHECK ("review"."version">0 and "review"."status" in ('pending','published','hidden','withdrawn') and "review"."request_fingerprint" ~ '^[a-f0-9]{64}$' and (("review"."status"='withdrawn' and "review"."public_name" is null and "review"."body" is null and "review"."rating" is null and "review"."reply" is null and "review"."moderation_reason" is null and "review"."share_services"=false) or ("review"."status"<>'withdrawn' and "review"."public_name" is not null and length(btrim("review"."public_name")) between 1 and 80 and "review"."body" is not null and length(btrim("review"."body")) between 1 and 2000 and "review"."rating" is not null and "review"."rating" between 1 and 5)) and ("review"."reply" is null or length(btrim("review"."reply")) between 1 and 1000) and ("review"."status"<>'published' or "review"."published_at" is not null) and ("review"."status"<>'hidden' or ("review"."moderation_reason" is not null and length(btrim("review"."moderation_reason")) between 1 and 300)))
);
--> statement-breakpoint
ALTER TABLE "review" ADD CONSTRAINT "review_appointment_id_appointment_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review" ADD CONSTRAINT "review_client_id_client_profile_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review" ADD CONSTRAINT "review_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_status_id_idx" ON "review" USING btree ("status","id");--> statement-breakpoint
CREATE INDEX "review_client_id_idx" ON "review" USING btree ("client_id","id");
--> statement-breakpoint
CREATE FUNCTION review_preserve_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.appointment_id, NEW.client_id, NEW.idempotency_key, NEW.request_fingerprint, NEW.services, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.appointment_id, OLD.client_id, OLD.idempotency_key, OLD.request_fingerprint, OLD.services, OLD.created_at)
    OR (NEW.created_by IS DISTINCT FROM OLD.created_by AND NEW.created_by IS NOT NULL) THEN
    RAISE EXCEPTION 'Review identity and original receipt are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER review_identity_immutable BEFORE UPDATE ON review FOR EACH ROW EXECUTE FUNCTION review_preserve_identity();
