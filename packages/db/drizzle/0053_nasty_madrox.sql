ALTER TABLE "resource_reservation" DROP CONSTRAINT "resource_reservation_valid";--> statement-breakpoint
ALTER TABLE "appointment" ADD COLUMN "source_resource_window" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "resource_reservation_source_appointment" ON "resource_reservation" USING btree ("appointment_id") WHERE "resource_reservation"."unit_index" >= 20;--> statement-breakpoint
ALTER TABLE "resource_reservation" ADD CONSTRAINT "resource_reservation_valid" CHECK (num_nonnulls("resource_reservation"."appointment_id","resource_reservation"."offer_id")=1 and "resource_reservation"."service_position">=0 and "resource_reservation"."unit_index" between 0 and 39 and "resource_reservation"."offset_minutes">=0 and "resource_reservation"."end_offset_minutes">"resource_reservation"."offset_minutes" and "resource_reservation"."end_offset_minutes"<=100000 and "resource_reservation"."ends_at">"resource_reservation"."starts_at");
--> statement-breakpoint
CREATE FUNCTION sob_check_resource_booking_capacity() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE
  slot public.resource_reservation%ROWTYPE;
  configured_capacity int;
  original jsonb;
  over_capacity boolean;
BEGIN
  SELECT * INTO slot FROM public.resource_reservation WHERE id=NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('resource:' || slot.resource_id::text,0));
  SELECT capacity INTO configured_capacity FROM public.resource_pool WHERE id=slot.resource_id;
  IF slot.unit_index>=20 THEN
    SELECT a.source_resource_window INTO original FROM public.appointment a
      WHERE a.id=slot.appointment_id AND a.visit_group_id IS NOT NULL;
    IF jsonb_typeof(original)='string' THEN original := (original #>> '{}')::jsonb; END IF;
    IF (original->>'resourceId') IS DISTINCT FROM slot.resource_id::text
      OR (original->>'startsAt')::timestamptz IS DISTINCT FROM slot.starts_at
      OR (original->>'endsAt')::timestamptz IS DISTINCT FROM slot.ends_at
      OR slot.service_position<>0 OR slot.offset_minutes<>0
    THEN
      RAISE EXCEPTION 'Resource exception requires its frozen source window' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NOT slot.active THEN RETURN NULL; END IF;
  WITH occupied AS MATERIALIZED (
    SELECT starts_at, ends_at, unit_index FROM public.resource_reservation
    WHERE resource_id=slot.resource_id AND active
      AND starts_at<slot.ends_at AND ends_at>slot.starts_at
  ), boundaries AS (
    SELECT DISTINCT greatest(starts_at,slot.starts_at) AS moment FROM occupied
  )
  SELECT EXISTS (
    SELECT 1 FROM boundaries b
    JOIN occupied r ON r.starts_at<=b.moment AND r.ends_at>b.moment
    GROUP BY b.moment
    HAVING count(*)>configured_capacity AND bool_or(r.unit_index<20)
  ) AND EXISTS (SELECT 1 FROM occupied WHERE unit_index>=20)
    INTO over_capacity;
  IF over_capacity THEN
    RAISE EXCEPTION 'Resource capacity exceeded' USING ERRCODE='23P01',CONSTRAINT='resource_reservation_no_overlap';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER resource_booking_capacity_guard
AFTER INSERT OR UPDATE ON resource_reservation
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sob_check_resource_booking_capacity();
--> statement-breakpoint
CREATE FUNCTION sob_retain_source_resource_window() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.source_resource_window IS DISTINCT FROM OLD.source_resource_window OR
     (OLD.source_resource_window IS NOT NULL AND NEW.visit_group_id IS DISTINCT FROM OLD.visit_group_id) THEN
    RAISE EXCEPTION 'Imported resource windows are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER appointment_retain_source_resource_window
BEFORE UPDATE OF source_resource_window,visit_group_id ON appointment
FOR EACH ROW EXECUTE FUNCTION sob_retain_source_resource_window();
