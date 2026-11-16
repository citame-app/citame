ALTER TABLE "resource_reservation" ADD COLUMN "released" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "resource_reservation" ADD CONSTRAINT "resource_reservation_release_owner" CHECK (not "resource_reservation"."released" or "resource_reservation"."offer_id" is not null);--> statement-breakpoint
ALTER TABLE resource_reservation ADD CONSTRAINT resource_reservation_no_overlap
EXCLUDE USING gist (resource_id WITH =, unit_index WITH =, tstzrange(starts_at,ends_at,'[)') WITH &&)
WHERE (active) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE FUNCTION sob_align_resource_reservation() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE owner_start timestamptz; owner_end timestamptz; owner_active boolean;
BEGIN
  IF NEW.appointment_id IS NOT NULL THEN
    SELECT starts_at, ends_at, status <> 'cancelled' AND deleted_at IS NULL
      INTO owner_start, owner_end, owner_active FROM public.appointment WHERE id=NEW.appointment_id;
  ELSE
    SELECT starts_at, ends_at, state='offered'
      INTO owner_start, owner_end, owner_active FROM public.waitlist_offer WHERE id=NEW.offer_id;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'Resource reservation owner not found' USING ERRCODE='23503'; END IF;
  NEW.starts_at := owner_start + make_interval(mins => NEW.offset_minutes);
  NEW.ends_at := owner_start + make_interval(mins => NEW.end_offset_minutes);
  NEW.active := owner_active AND NOT NEW.released;
  IF NEW.starts_at < owner_start OR NEW.ends_at > owner_end THEN
    RAISE EXCEPTION 'Resource reservation exceeds owner window' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER resource_reservation_align BEFORE INSERT OR UPDATE ON resource_reservation
FOR EACH ROW EXECUTE FUNCTION sob_align_resource_reservation();
--> statement-breakpoint
CREATE FUNCTION sob_refresh_owned_resources() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_TABLE_NAME='appointment' THEN
    UPDATE public.resource_reservation SET starts_at=NEW.starts_at WHERE appointment_id=NEW.id;
  ELSE
    UPDATE public.resource_reservation SET starts_at=NEW.starts_at WHERE offer_id=NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER appointment_refresh_resources AFTER UPDATE OF starts_at,ends_at,status,deleted_at ON appointment
FOR EACH ROW WHEN (OLD.starts_at IS DISTINCT FROM NEW.starts_at OR OLD.ends_at IS DISTINCT FROM NEW.ends_at OR OLD.status IS DISTINCT FROM NEW.status OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
EXECUTE FUNCTION sob_refresh_owned_resources();
--> statement-breakpoint
CREATE TRIGGER offer_refresh_resources AFTER UPDATE OF starts_at,ends_at,state ON waitlist_offer
FOR EACH ROW WHEN (OLD.starts_at IS DISTINCT FROM NEW.starts_at OR OLD.ends_at IS DISTINCT FROM NEW.ends_at OR OLD.state IS DISTINCT FROM NEW.state)
EXECUTE FUNCTION sob_refresh_owned_resources();
