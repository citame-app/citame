ALTER TABLE service_combination ADD COLUMN fixed_online_booking boolean;
--> statement-breakpoint
ALTER TABLE appointment
  ADD COLUMN combination_id uuid REFERENCES service_combination(id),
  ADD COLUMN combination_staff_ids uuid[],
  ADD CONSTRAINT appointment_combination_staff_valid CHECK (
    (combination_id IS NULL AND combination_staff_ids IS NULL) OR (
      combination_id IS NOT NULL AND combination_staff_ids IS NOT NULL
      AND cardinality(combination_staff_ids) BETWEEN 1 AND 100
      AND array_position(combination_staff_ids, NULL) IS NULL
      AND staff_id = ANY(combination_staff_ids)
    )
  );
