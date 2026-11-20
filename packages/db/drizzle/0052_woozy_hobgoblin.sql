ALTER TABLE "staff_reservation" DROP CONSTRAINT "staff_reservation_valid";--> statement-breakpoint
ALTER TABLE "appointment" ADD COLUMN "source_staff_window" jsonb;--> statement-breakpoint
ALTER TABLE "staff_reservation" ADD CONSTRAINT "staff_reservation_valid" CHECK (num_nonnulls("staff_reservation"."appointment_id","staff_reservation"."offer_id")=1 and "staff_reservation"."position">=0 and "staff_reservation"."unit_index" between 0 and 11 and "staff_reservation"."offset_minutes">=0 and ("staff_reservation"."end_offset_minutes" is null or "staff_reservation"."end_offset_minutes">"staff_reservation"."offset_minutes") and "staff_reservation"."ends_at">"staff_reservation"."starts_at" and (not "staff_reservation"."released" or "staff_reservation"."offer_id" is not null));
--> statement-breakpoint
CREATE FUNCTION sob_staff_capacity_overflow(
  professional uuid, capacity int, range_start timestamptz, range_end timestamptz
) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
  WITH occupied AS MATERIALIZED (
    SELECT starts_at, ends_at, unit_index
    FROM public.staff_reservation
    WHERE staff_id=professional AND active
      AND starts_at<range_end AND ends_at>range_start
  ), boundaries AS (
    SELECT DISTINCT greatest(starts_at,range_start) AS moment FROM occupied
  )
  SELECT EXISTS (
    SELECT 1 FROM boundaries b
    JOIN occupied r ON r.starts_at<=b.moment AND r.ends_at>b.moment
    GROUP BY b.moment
    HAVING count(*)>capacity AND bool_or(r.unit_index<6)
  ) AND EXISTS (SELECT 1 FROM occupied WHERE unit_index>=6);
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sob_check_staff_capacity() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE
  slot public.staff_reservation%ROWTYPE;
  professional public.staff_profile%ROWTYPE;
  original jsonb;
  bad boolean;
BEGIN
  IF TG_TABLE_NAME='staff_profile' THEN
    SELECT * INTO professional FROM public.staff_profile WHERE id=NEW.id;
    IF NOT FOUND THEN RETURN NULL; END IF;
    bad := EXISTS (
      SELECT 1 FROM public.staff_reservation r WHERE r.staff_id=professional.id
        AND r.active AND r.ends_at>professional.capacity_effective_at
        AND r.unit_index>=professional.max_concurrent AND r.unit_index<6
    ) OR public.sob_staff_capacity_overflow(
      professional.id, professional.max_concurrent,
      professional.capacity_effective_at, 'infinity'::timestamptz
    );
  ELSE
    SELECT * INTO slot FROM public.staff_reservation WHERE id=NEW.id;
    IF NOT FOUND THEN RETURN NULL; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(slot.staff_id::text,0));
    SELECT * INTO professional FROM public.staff_profile WHERE id=slot.staff_id;
    IF slot.unit_index>=6 THEN
      SELECT a.source_staff_window INTO original FROM public.appointment a
        WHERE a.id=slot.appointment_id AND a.visit_group_id IS NOT NULL;
      IF jsonb_typeof(original)='string' THEN original := (original #>> '{}')::jsonb; END IF;
      IF (original->>'staffId') IS DISTINCT FROM slot.staff_id::text
        OR (original->>'startsAt')::timestamptz IS DISTINCT FROM slot.starts_at
        OR (original->>'endsAt')::timestamptz IS DISTINCT FROM slot.ends_at
      THEN
        RAISE EXCEPTION 'Staff exception requires its frozen source window' USING ERRCODE='23514';
      END IF;
    END IF;
    bad := slot.active AND slot.ends_at>professional.capacity_effective_at AND (
      (slot.unit_index>=professional.max_concurrent AND slot.unit_index<6)
      OR public.sob_staff_capacity_overflow(
        slot.staff_id, professional.max_concurrent,
        greatest(slot.starts_at,professional.capacity_effective_at), slot.ends_at
      )
    );
  END IF;
  IF bad THEN
    RAISE EXCEPTION 'Professional capacity exceeded' USING ERRCODE='23P01',CONSTRAINT='appointment_no_overlap';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION sob_retain_source_staff_window() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.source_staff_window IS DISTINCT FROM OLD.source_staff_window OR
     (OLD.source_staff_window IS NOT NULL AND NEW.visit_group_id IS DISTINCT FROM OLD.visit_group_id) THEN
    RAISE EXCEPTION 'Imported staff windows are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER appointment_retain_source_staff_window
BEFORE UPDATE OF source_staff_window,visit_group_id ON appointment
FOR EACH ROW EXECUTE FUNCTION sob_retain_source_staff_window();
