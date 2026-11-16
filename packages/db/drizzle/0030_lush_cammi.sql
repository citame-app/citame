CREATE TABLE "intake_appointment" (
	"appointment_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intake_appointment_appointment_id_submission_id_pk" PRIMARY KEY("appointment_id","submission_id")
);
--> statement-breakpoint
ALTER TABLE "intake_appointment" ADD CONSTRAINT "intake_appointment_appointment_id_appointment_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_appointment" ADD CONSTRAINT "intake_appointment_submission_id_intake_submission_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."intake_submission"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_appointment" ADD CONSTRAINT "intake_appointment_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "intake_appointment_submission_idx" ON "intake_appointment" USING btree ("submission_id");
--> statement-breakpoint
CREATE FUNCTION intake_preserve_association() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Intake associations are immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND ((to_jsonb(NEW) - 'created_by') IS DISTINCT FROM (to_jsonb(OLD) - 'created_by')
    OR (NEW.created_by IS DISTINCT FROM OLD.created_by AND NEW.created_by IS NOT NULL)) THEN
    RAISE EXCEPTION 'Intake associations are immutable' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM appointment a JOIN intake_submission s ON s.client_id=a.client_id WHERE a.id=NEW.appointment_id AND s.id=NEW.submission_id) THEN
    RAISE EXCEPTION 'Intake appointment ownership must match' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER intake_appointment_scope BEFORE INSERT OR UPDATE OR DELETE ON intake_appointment
FOR EACH ROW EXECUTE FUNCTION intake_preserve_association();
