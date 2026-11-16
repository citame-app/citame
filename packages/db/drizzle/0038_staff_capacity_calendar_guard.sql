-- Direct SQL policy writers serialize with the same calendar lock held by allocation triggers.
CREATE FUNCTION sob_lock_staff_capacity_calendar() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.id::text,0));
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER staff_capacity_calendar_lock BEFORE UPDATE OF max_concurrent,capacity_effective_at ON staff_profile
FOR EACH ROW EXECUTE FUNCTION sob_lock_staff_capacity_calendar();
