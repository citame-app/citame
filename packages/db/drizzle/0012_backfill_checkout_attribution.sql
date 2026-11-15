-- Preserve appointment attribution on receipts created before commissions were introduced.
UPDATE checkout c SET staff_id = a.staff_id FROM appointment a
WHERE c.appointment_id = a.id AND c.staff_id IS NULL;

-- Only unfulfilled receipts will accrue commissions. Allocate their discounts exactly;
-- settled historical receipts and their tax totals remain untouched.
DO $$
DECLARE
  sale record;
  line record;
  remaining_gross bigint;
  remaining_discount bigint;
  line_gross bigint;
  allocated bigint;
  included_tax bigint;
  total_tax bigint;
BEGIN
  FOR sale IN SELECT id, subtotal_cents, discount_cents FROM checkout
    WHERE fulfilled_at IS NULL AND status = 'open'
  LOOP
    remaining_gross := sale.subtotal_cents;
    remaining_discount := sale.discount_cents;
    total_tax := 0;
    FOR line IN SELECT id, quantity, unit_amount_cents, tax_basis_points FROM checkout_line
      WHERE checkout_id = sale.id ORDER BY created_at, id
    LOOP
      line_gross := line.quantity::bigint * line.unit_amount_cents;
      allocated := CASE WHEN remaining_gross = 0 THEN 0
        ELSE remaining_discount * line_gross / remaining_gross END;
      included_tax := round((line_gross - allocated)::numeric * line.tax_basis_points / (10000 + line.tax_basis_points));
      UPDATE checkout_line SET discount_cents = allocated, tax_cents = included_tax WHERE id = line.id;
      remaining_gross := remaining_gross - line_gross;
      remaining_discount := remaining_discount - allocated;
      total_tax := total_tax + included_tax;
    END LOOP;
    UPDATE checkout SET tax_cents = total_tax WHERE id = sale.id;
  END LOOP;
END $$;
