CREATE TABLE "date_shift" (
	"id" uuid PRIMARY KEY NOT NULL,
	"staff_id" uuid NOT NULL,
	"date" date NOT NULL,
	"ranges" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "date_shift_staff_date_unique" UNIQUE("staff_id","date"),
	CONSTRAINT "date_shift_version_valid" CHECK ("date_shift"."version">0)
);
--> statement-breakpoint
CREATE TABLE "date_shift_batch" (
	"id" uuid PRIMARY KEY NOT NULL,
	"staff_id" uuid NOT NULL,
	"created_by" text,
	"idempotency_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"dates" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "date_shift_batch_actor_key_unique" UNIQUE("created_by","idempotency_key"),
	CONSTRAINT "date_shift_batch_valid" CHECK ("date_shift_batch"."request_fingerprint" ~ '^[a-f0-9]{64}$' and cardinality("date_shift_batch"."dates") between 1 and 84)
);
--> statement-breakpoint
ALTER TABLE "date_shift" ADD CONSTRAINT "date_shift_staff_id_staff_profile_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "date_shift_batch" ADD CONSTRAINT "date_shift_batch_staff_id_staff_profile_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "date_shift_batch" ADD CONSTRAINT "date_shift_batch_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sync_record_date_shift AFTER INSERT OR UPDATE OR DELETE ON date_shift
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sync_record_change('date_shift', 'id');
--> statement-breakpoint
CREATE FUNCTION date_shift_preserve_batch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Applied shift batches are immutable' USING ERRCODE='23514'; END IF;
  IF (to_jsonb(NEW)-'created_by') IS DISTINCT FROM (to_jsonb(OLD)-'created_by') OR (NEW.created_by IS DISTINCT FROM OLD.created_by AND NEW.created_by IS NOT NULL) THEN
    RAISE EXCEPTION 'Applied shift batches are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER date_shift_batch_immutable BEFORE UPDATE OR DELETE ON date_shift_batch
FOR EACH ROW EXECUTE FUNCTION date_shift_preserve_batch();
