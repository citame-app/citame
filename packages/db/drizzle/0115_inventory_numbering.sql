-- Look up only Citame's two existing identity sequences. A runtime role with basic DML
-- grants can use the bounded functions below without owning either document table.
CREATE FUNCTION public.inventory_numbering_status(series text)
RETURNS TABLE(allocated_next bigint, next_number integer, last_issued_number integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  relation_name text;
  sequence_name text;
  sequence_schema text;
  recorded_max bigint;
  candidate bigint;
BEGIN
  relation_name := CASE series WHEN 'orders' THEN 'purchase_order'
                               WHEN 'receipts' THEN 'stock_receipt' END;
  IF relation_name IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Unknown document series';
  END IF;
  SELECT c.relname, n.nspname, s.seqmax INTO sequence_name, sequence_schema, recorded_max
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_sequence s ON s.seqrelid = c.oid
  WHERE c.oid = pg_get_serial_sequence(format('public.%I', relation_name), 'number')::regclass
    AND s.seqcache = 1 AND s.seqincrement = 1 AND NOT s.seqcycle;
  IF recorded_max IS DISTINCT FROM 2147483647 THEN
    RAISE EXCEPTION 'Document numbering is not configured';
  END IF;
  EXECUTE format(
    'SELECT last_value + is_called::integer, (SELECT max(number) FROM public.%I) FROM %I.%I',
    relation_name, sequence_schema, sequence_name
  ) INTO STRICT allocated_next, last_issued_number;
  candidate := greatest(allocated_next, coalesce(last_issued_number, 0)::bigint + 1);
  next_number := CASE WHEN candidate <= recorded_max THEN candidate::integer END;
  RETURN NEXT;
END;
$fn$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.inventory_numbering_status(text) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.inventory_numbering_advance(series text, expected integer, proposed integer)
RETURNS TABLE(previous_number integer, next_number integer, last_issued_number integer, changed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  relation_name text;
  current_series record;
BEGIN
  relation_name := CASE series WHEN 'orders' THEN 'purchase_order'
                               WHEN 'receipts' THEN 'stock_receipt' END;
  IF relation_name IS NULL OR expected IS NULL OR expected < 1
    OR proposed IS NULL OR proposed < expected THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'The next document number can only increase';
  END IF;

  -- An insert locks its table before allocating the identity. Use that same lock before
  -- reading the reviewed number; a numbering edit should never wait on a document writer.
  EXECUTE format('LOCK TABLE public.%I IN ACCESS EXCLUSIVE MODE NOWAIT', relation_name);
  SELECT * INTO STRICT current_series FROM public.inventory_numbering_status(series);
  IF current_series.next_number IS DISTINCT FROM expected THEN
    RAISE EXCEPTION USING ERRCODE = 'PT409', MESSAGE = 'The series changed. Review the next document number.';
  END IF;

  changed := proposed <> current_series.allocated_next;
  IF changed THEN
    -- RESTART rolls back with the surrounding transaction, including audit and live events.
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN number RESTART WITH %s', relation_name, proposed);
  END IF;
  previous_number := current_series.next_number;
  next_number := proposed;
  last_issued_number := current_series.last_issued_number;
  RETURN NEXT;
END;
$fn$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.inventory_numbering_advance(text, integer, integer) FROM PUBLIC;
