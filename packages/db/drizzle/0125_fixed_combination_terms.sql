ALTER TABLE service_combination
  ADD COLUMN fixed_prices_cents integer[],
  ADD COLUMN fixed_staff_ids uuid[],
  ADD CONSTRAINT service_combination_fixed_terms CHECK (
    (fixed_prices_cents IS NULL AND fixed_staff_ids IS NULL) OR (
      fixed_prices_cents IS NOT NULL AND fixed_staff_ids IS NOT NULL
      AND cardinality(fixed_prices_cents) = cardinality(service_ids)
      AND array_position(fixed_prices_cents, NULL) IS NULL
      AND 0 <= ALL(fixed_prices_cents) AND 999999999 >= ALL(fixed_prices_cents)
      AND cardinality(fixed_staff_ids) BETWEEN 1 AND 100
      AND array_position(fixed_staff_ids, NULL) IS NULL
    )
  );
