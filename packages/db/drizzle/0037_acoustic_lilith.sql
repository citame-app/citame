CREATE TABLE "staff_reservation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"staff_id" uuid NOT NULL,
	"appointment_id" uuid,
	"offer_id" uuid,
	"position" integer NOT NULL,
	"unit_index" integer NOT NULL,
	"offset_minutes" integer NOT NULL,
	"end_offset_minutes" integer,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"released" boolean DEFAULT false NOT NULL,
	CONSTRAINT "staff_reservation_valid" CHECK (num_nonnulls("staff_reservation"."appointment_id","staff_reservation"."offer_id")=1 and "staff_reservation"."position">=0 and "staff_reservation"."unit_index" between 0 and 5 and "staff_reservation"."offset_minutes">=0 and ("staff_reservation"."end_offset_minutes" is null or "staff_reservation"."end_offset_minutes">"staff_reservation"."offset_minutes") and "staff_reservation"."ends_at">"staff_reservation"."starts_at" and (not "staff_reservation"."released" or "staff_reservation"."offer_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "appointment" ADD COLUMN "work_windows" jsonb;--> statement-breakpoint
ALTER TABLE "appointment_service" ADD COLUMN "processing_start_minutes" integer;--> statement-breakpoint
ALTER TABLE "appointment_service" ADD COLUMN "processing_minutes" integer;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "processing_start_minutes" integer;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "processing_minutes" integer;--> statement-breakpoint
ALTER TABLE "staff_profile" ADD COLUMN "max_concurrent" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "staff_profile" ADD COLUMN "capacity_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "staff_profile" ADD COLUMN "capacity_effective_at" timestamp with time zone DEFAULT 'epoch'::timestamptz NOT NULL;--> statement-breakpoint
ALTER TABLE "waitlist_offer" ADD COLUMN "work_windows" jsonb;--> statement-breakpoint
ALTER TABLE "staff_reservation" ADD CONSTRAINT "staff_reservation_staff_id_staff_profile_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_reservation" ADD CONSTRAINT "staff_reservation_appointment_id_appointment_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_reservation" ADD CONSTRAINT "staff_reservation_offer_id_waitlist_offer_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."waitlist_offer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "staff_reservation_appointment_position" ON "staff_reservation" USING btree ("appointment_id","position") WHERE "staff_reservation"."appointment_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "staff_reservation_offer_position" ON "staff_reservation" USING btree ("offer_id","position") WHERE "staff_reservation"."offer_id" is not null;--> statement-breakpoint
CREATE INDEX "staff_reservation_calendar_idx" ON "staff_reservation" USING btree ("staff_id","starts_at") WHERE "staff_reservation"."active";--> statement-breakpoint
ALTER TABLE "appointment_service" ADD CONSTRAINT "appointment_service_processing_valid" CHECK (("appointment_service"."processing_start_minutes" is null and "appointment_service"."processing_minutes" is null) or ("appointment_service"."processing_start_minutes" is not null and "appointment_service"."processing_minutes" is not null and "appointment_service"."processing_start_minutes">0 and "appointment_service"."processing_minutes">0 and "appointment_service"."processing_start_minutes"+"appointment_service"."processing_minutes"<"appointment_service"."duration_minutes"));--> statement-breakpoint
ALTER TABLE "service" ADD CONSTRAINT "service_processing_valid" CHECK (("service"."processing_start_minutes" is null and "service"."processing_minutes" is null) or ("service"."processing_start_minutes" is not null and "service"."processing_minutes" is not null and "service"."processing_start_minutes">0 and "service"."processing_minutes">0 and "service"."processing_start_minutes"+"service"."processing_minutes"<"service"."duration_minutes"));--> statement-breakpoint
ALTER TABLE "staff_profile" ADD CONSTRAINT "staff_capacity_valid" CHECK ("staff_profile"."max_concurrent" between 1 and 6 and "staff_profile"."capacity_version">0);--> statement-breakpoint
-- The scheduling advisory lock is shared with all catalog, booking and waitlist writers.
SELECT pg_advisory_xact_lock(hashtextextended('sob-scheduling-capacity-v1',0));
--> statement-breakpoint
CREATE FUNCTION sob_work_document(value jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
BEGIN
  IF value IS NULL THEN RETURN NULL; END IF;
  IF jsonb_typeof(value)='string' THEN value := (value #>> '{}')::jsonb; END IF;
  IF jsonb_typeof(value)<>'array' OR jsonb_array_length(value) NOT BETWEEN 1 AND 48 THEN
    RAISE EXCEPTION 'Invalid frozen professional work plan' USING ERRCODE='23514';
  END IF;
  RETURN value;
EXCEPTION WHEN invalid_text_representation THEN
  RAISE EXCEPTION 'Invalid frozen professional work plan' USING ERRCODE='23514';
END;
$$;
--> statement-breakpoint
CREATE FUNCTION sob_align_staff_reservation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE owner_start timestamptz; owner_end timestamptz; owner_staff uuid; owner_active boolean; windows jsonb; part jsonb;
BEGIN
  IF TG_OP='UPDATE' AND ROW(NEW.appointment_id,NEW.offer_id,NEW.position) IS DISTINCT FROM ROW(OLD.appointment_id,OLD.offer_id,OLD.position) THEN
    RAISE EXCEPTION 'Professional reservation identity is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.appointment_id IS NOT NULL THEN
    SELECT starts_at,ends_at,staff_id,status<>'cancelled' AND deleted_at IS NULL,work_windows
      INTO owner_start,owner_end,owner_staff,owner_active,windows FROM public.appointment WHERE id=NEW.appointment_id;
  ELSE
    SELECT starts_at,ends_at,staff_id,state='offered',work_windows
      INTO owner_start,owner_end,owner_staff,owner_active,windows FROM public.waitlist_offer WHERE id=NEW.offer_id;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'Professional reservation owner not found' USING ERRCODE='23503'; END IF;
  windows := public.sob_work_document(windows);
  IF windows IS NULL THEN
    IF NEW.position<>0 THEN RAISE EXCEPTION 'Invalid full-window position' USING ERRCODE='23514'; END IF;
    NEW.offset_minutes := 0; NEW.end_offset_minutes := NULL;
  ELSE
    part := windows -> NEW.position;
    IF part IS NULL THEN RAISE EXCEPTION 'Invalid work-window position' USING ERRCODE='23514'; END IF;
    NEW.offset_minutes := (part->>'offsetMinutes')::int;
    NEW.end_offset_minutes := (part->>'endOffsetMinutes')::int;
  END IF;
  NEW.staff_id := owner_staff;
  NEW.starts_at := owner_start + make_interval(mins=>NEW.offset_minutes);
  NEW.ends_at := CASE WHEN NEW.end_offset_minutes IS NULL THEN owner_end ELSE owner_start+make_interval(mins=>NEW.end_offset_minutes) END;
  NEW.active := owner_active AND NOT NEW.released;
  IF NEW.starts_at < owner_start OR NEW.ends_at > owner_end THEN
    RAISE EXCEPTION 'Professional reservation exceeds its owner' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER staff_reservation_align BEFORE INSERT OR UPDATE ON staff_reservation
FOR EACH ROW EXECUTE FUNCTION sob_align_staff_reservation();
--> statement-breakpoint
-- Existing visits keep their original continuous work plan. Expired legacy offers hold no capacity.
INSERT INTO staff_reservation(id,staff_id,appointment_id,position,unit_index,offset_minutes,starts_at,ends_at)
SELECT gen_random_uuid(),staff_id,id,0,0,0,starts_at,ends_at FROM appointment;
--> statement-breakpoint
INSERT INTO staff_reservation(id,staff_id,offer_id,position,unit_index,offset_minutes,starts_at,ends_at,released)
SELECT gen_random_uuid(),staff_id,id,0,0,0,starts_at,ends_at,expires_at<=CURRENT_TIMESTAMP FROM waitlist_offer;
--> statement-breakpoint
ALTER TABLE appointment DROP CONSTRAINT appointment_no_overlap;
--> statement-breakpoint
ALTER TABLE waitlist_offer DROP CONSTRAINT waitlist_offer_no_overlap;
--> statement-breakpoint
ALTER TABLE staff_reservation ADD CONSTRAINT appointment_no_overlap
EXCLUDE USING gist (staff_id WITH =,unit_index WITH =,tstzrange(starts_at,ends_at,'[)') WITH &&)
WHERE(active) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE FUNCTION sob_refresh_staff_work() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE windows jsonb; part jsonb; current_position int:=0; previous_end int:=0; start_offset int; end_offset int;
  cap int; chosen int; lock_staff text; owner_active boolean; range_start timestamptz; range_end timestamptz;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF OLD.work_windows IS DISTINCT FROM NEW.work_windows THEN
      RAISE EXCEPTION 'Booked professional work plans are immutable' USING ERRCODE='23514';
    END IF;
    FOR lock_staff IN SELECT DISTINCT value::text FROM unnest(ARRAY[OLD.staff_id,NEW.staff_id]) value ORDER BY value::text LOOP
      PERFORM pg_advisory_xact_lock(hashtextextended(lock_staff,0));
    END LOOP;
    IF OLD.staff_id=NEW.staff_id AND OLD.starts_at=NEW.starts_at AND OLD.ends_at=NEW.ends_at THEN
      IF TG_TABLE_NAME='appointment' THEN
        UPDATE public.staff_reservation SET starts_at=NEW.starts_at WHERE appointment_id=NEW.id;
      ELSE
        UPDATE public.staff_reservation SET starts_at=NEW.starts_at WHERE offer_id=NEW.id;
      END IF;
      RETURN NEW;
    END IF;
  ELSE
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.staff_id::text,0));
  END IF;
  SELECT max_concurrent INTO cap FROM public.staff_profile WHERE id=NEW.staff_id;
  IF TG_TABLE_NAME='appointment' THEN
    DELETE FROM public.staff_reservation WHERE appointment_id=NEW.id;
    owner_active := NEW.status<>'cancelled' AND NEW.deleted_at IS NULL;
  ELSE
    DELETE FROM public.staff_reservation WHERE offer_id=NEW.id;
    owner_active := NEW.state='offered';
  END IF;
  windows := public.sob_work_document(NEW.work_windows);
  IF windows IS NULL THEN windows := jsonb_build_array(jsonb_build_object('offsetMinutes',0,'endOffsetMinutes',NULL)); END IF;
  FOR part IN SELECT value FROM jsonb_array_elements(windows) LOOP
    IF jsonb_typeof(part)<>'object' OR (part->>'offsetMinutes') !~ '^[0-9]+$' OR
       (part->>'offsetMinutes') IS NULL OR ((part->>'endOffsetMinutes') IS NOT NULL AND (part->>'endOffsetMinutes') !~ '^[0-9]+$') THEN
      RAISE EXCEPTION 'Invalid professional work-window offsets' USING ERRCODE='23514';
    END IF;
    start_offset := (part->>'offsetMinutes')::int;
    end_offset := (part->>'endOffsetMinutes')::int;
    IF start_offset<previous_end OR (current_position=0 AND start_offset<>0) OR
       (end_offset IS NOT NULL AND (end_offset<=start_offset OR end_offset>100000)) OR
       (end_offset IS NULL AND NEW.work_windows IS NOT NULL) THEN
      RAISE EXCEPTION 'Invalid ordered professional work windows' USING ERRCODE='23514';
    END IF;
    range_start := NEW.starts_at+make_interval(mins=>start_offset);
    range_end := CASE WHEN end_offset IS NULL THEN NEW.ends_at ELSE NEW.starts_at+make_interval(mins=>end_offset) END;
    IF range_end>NEW.ends_at OR range_end<=range_start THEN RAISE EXCEPTION 'Work window exceeds visit' USING ERRCODE='23514'; END IF;
    SELECT unit INTO chosen FROM generate_series(0,cap-1) unit
      WHERE NOT EXISTS(SELECT 1 FROM public.staff_reservation r WHERE r.staff_id=NEW.staff_id AND r.unit_index=unit AND r.active AND r.starts_at<range_end AND r.ends_at>range_start)
      ORDER BY unit LIMIT 1;
    -- The application may recolour interchangeable slots before the deferred constraints run.
    chosen := COALESCE(chosen,0);
    INSERT INTO public.staff_reservation(id,staff_id,appointment_id,offer_id,position,unit_index,offset_minutes,end_offset_minutes,starts_at,ends_at,active)
      VALUES(gen_random_uuid(),NEW.staff_id,CASE WHEN TG_TABLE_NAME='appointment' THEN NEW.id ELSE NULL END,
        CASE WHEN TG_TABLE_NAME='waitlist_offer' THEN NEW.id ELSE NULL END,current_position,chosen,start_offset,end_offset,range_start,range_end,owner_active);
    previous_end := COALESCE(end_offset,0); current_position := current_position+1;
  END LOOP;
  IF range_end IS DISTINCT FROM NEW.ends_at THEN RAISE EXCEPTION 'A frozen work plan must retain final work and cleanup' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER appointment_staff_work AFTER INSERT OR UPDATE OF staff_id,starts_at,ends_at,status,deleted_at,work_windows ON appointment
FOR EACH ROW EXECUTE FUNCTION sob_refresh_staff_work();
--> statement-breakpoint
CREATE TRIGGER offer_staff_work AFTER INSERT OR UPDATE OF staff_id,starts_at,ends_at,state,work_windows ON waitlist_offer
FOR EACH ROW EXECUTE FUNCTION sob_refresh_staff_work();
--> statement-breakpoint
CREATE FUNCTION sob_check_staff_capacity() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE bad boolean;
BEGIN
  IF TG_TABLE_NAME='staff_profile' THEN
    SELECT EXISTS(SELECT 1 FROM public.staff_reservation r JOIN public.staff_profile s ON s.id=r.staff_id
      WHERE s.id=NEW.id AND r.active AND r.ends_at>s.capacity_effective_at AND r.unit_index>=s.max_concurrent) INTO bad;
  ELSE
    SELECT EXISTS(SELECT 1 FROM public.staff_reservation r JOIN public.staff_profile s ON s.id=r.staff_id
      WHERE r.id=NEW.id AND r.active AND r.ends_at>s.capacity_effective_at AND r.unit_index>=s.max_concurrent) INTO bad;
  END IF;
  IF bad THEN RAISE EXCEPTION 'Professional capacity exceeded' USING ERRCODE='23P01',CONSTRAINT='appointment_no_overlap'; END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER staff_capacity_policy_guard AFTER UPDATE ON staff_profile
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sob_check_staff_capacity();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER staff_capacity_slot_guard AFTER INSERT OR UPDATE ON staff_reservation
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sob_check_staff_capacity();
--> statement-breakpoint
CREATE FUNCTION sob_check_staff_work_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE source_id uuid; source_appointment uuid; source_offer uuid; windows jsonb; expected int; actual int;
BEGIN
  source_appointment := CASE WHEN TG_OP='DELETE' THEN OLD.appointment_id ELSE NEW.appointment_id END;
  source_offer := CASE WHEN TG_OP='DELETE' THEN OLD.offer_id ELSE NEW.offer_id END;
  IF source_appointment IS NOT NULL THEN
    SELECT work_windows INTO windows FROM public.appointment WHERE id=source_appointment;
  ELSE
    SELECT work_windows INTO windows FROM public.waitlist_offer WHERE id=source_offer;
  END IF;
  IF NOT FOUND THEN RETURN NULL; END IF;
  windows := public.sob_work_document(windows); expected := COALESCE(jsonb_array_length(windows),1);
  SELECT count(*) INTO actual FROM public.staff_reservation WHERE
    (source_appointment IS NOT NULL AND appointment_id=source_appointment) OR (source_offer IS NOT NULL AND offer_id=source_offer);
  IF expected<>actual THEN RAISE EXCEPTION 'Professional work reservations cannot be removed independently' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER staff_work_complete AFTER INSERT OR UPDATE OR DELETE ON staff_reservation
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sob_check_staff_work_complete();
