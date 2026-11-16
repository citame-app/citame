CREATE TABLE "intake_form" (
	"id" uuid PRIMARY KEY NOT NULL,
	"draft" jsonb NOT NULL,
	"current_revision_id" uuid,
	"active" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"idempotency_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intake_form_actor_key_unique" UNIQUE("created_by","idempotency_key"),
	CONSTRAINT "intake_form_valid" CHECK ("intake_form"."version">0 and (not "intake_form"."active" or "intake_form"."current_revision_id" is not null) and "intake_form"."request_fingerprint" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "intake_revision" (
	"id" uuid PRIMARY KEY NOT NULL,
	"form_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"definition" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intake_revision_number_unique" UNIQUE("form_id","number"),
	CONSTRAINT "intake_revision_content_unique" UNIQUE("form_id","content_hash"),
	CONSTRAINT "intake_revision_valid" CHECK ("intake_revision"."number">0 and length("intake_revision"."title") between 1 and 120 and "intake_revision"."content_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "intake_submission" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"appointment_id" uuid,
	"answers" jsonb NOT NULL,
	"source" text NOT NULL,
	"confirmation_version" text NOT NULL,
	"created_by" text,
	"idempotency_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intake_submission_actor_key_unique" UNIQUE("created_by","idempotency_key"),
	CONSTRAINT "intake_submission_valid" CHECK ("intake_submission"."source" in ('client','team') and "intake_submission"."request_fingerprint" ~ '^[a-f0-9]{64}$' and length("intake_submission"."confirmation_version") between 1 and 80)
);
--> statement-breakpoint
ALTER TABLE "intake_form" ADD CONSTRAINT "intake_form_current_revision_id_intake_revision_id_fk" FOREIGN KEY ("current_revision_id") REFERENCES "public"."intake_revision"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_form" ADD CONSTRAINT "intake_form_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_revision" ADD CONSTRAINT "intake_revision_form_id_intake_form_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."intake_form"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_revision" ADD CONSTRAINT "intake_revision_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_submission" ADD CONSTRAINT "intake_submission_client_id_client_profile_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_submission" ADD CONSTRAINT "intake_submission_revision_id_intake_revision_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."intake_revision"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_submission" ADD CONSTRAINT "intake_submission_appointment_id_appointment_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_submission" ADD CONSTRAINT "intake_submission_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "intake_submission_client_idx" ON "intake_submission" USING btree ("client_id","created_at");--> statement-breakpoint
CREATE INDEX "intake_submission_appointment_idx" ON "intake_submission" USING btree ("appointment_id");
--> statement-breakpoint
CREATE FUNCTION intake_preserve_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Published intake revisions are immutable' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - 'created_by') IS DISTINCT FROM (to_jsonb(OLD) - 'created_by')
     OR (NEW.created_by IS DISTINCT FROM OLD.created_by AND NEW.created_by IS NOT NULL) THEN
    RAISE EXCEPTION 'Published intake revisions are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER intake_revision_immutable BEFORE UPDATE OR DELETE ON intake_revision
FOR EACH ROW EXECUTE FUNCTION intake_preserve_revision();
--> statement-breakpoint
CREATE FUNCTION intake_preserve_submission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Intake answers are append-only' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - 'created_by' - 'appointment_id') IS DISTINCT FROM (to_jsonb(OLD) - 'created_by' - 'appointment_id')
     OR (NEW.created_by IS DISTINCT FROM OLD.created_by AND NEW.created_by IS NOT NULL)
     OR (NEW.appointment_id IS DISTINCT FROM OLD.appointment_id AND (OLD.appointment_id IS NOT NULL OR NEW.appointment_id IS NULL)) THEN
    RAISE EXCEPTION 'Intake answers are append-only' USING ERRCODE = '23514';
  END IF;
  IF NEW.appointment_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM appointment WHERE id=NEW.appointment_id AND client_id=NEW.client_id) THEN
    RAISE EXCEPTION 'Intake appointment ownership must match' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER intake_submission_immutable BEFORE UPDATE OR DELETE ON intake_submission
FOR EACH ROW EXECUTE FUNCTION intake_preserve_submission();
--> statement-breakpoint
CREATE FUNCTION intake_match_current_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.current_revision_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM intake_revision WHERE id=NEW.current_revision_id AND form_id=NEW.id) THEN
    RAISE EXCEPTION 'Current intake revision belongs to another form' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER intake_form_revision_scope BEFORE INSERT OR UPDATE ON intake_form
FOR EACH ROW EXECUTE FUNCTION intake_match_current_revision();

--> statement-breakpoint
CREATE FUNCTION intake_match_submission_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.appointment_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM appointment WHERE id=NEW.appointment_id AND client_id=NEW.client_id) THEN
    RAISE EXCEPTION 'Intake appointment ownership must match' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER intake_submission_owner BEFORE INSERT ON intake_submission
FOR EACH ROW EXECUTE FUNCTION intake_match_submission_owner();
