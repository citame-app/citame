import { type SalesFamilyTotal, salesFamilySchema } from "@sob/contracts";
import { sql } from "drizzle-orm";
import type { Tx } from "../../tx";

const familyOrder = sql.join(
  salesFamilySchema.options.map((family) => sql`${family}`),
  sql`, `,
);
const lineFamilies = sql.join(
  salesFamilySchema.options
    .filter((family) => family !== "other" && family !== "unallocated")
    .map((family) => sql`${family}`),
  sql`, `,
);

// The accounting queries use pr for the redemption and c for its receipt.
export const redeemedAtSettlement = sql`(pr.refunded_at is null or pr.refunded_at > c.fulfilled_at)`;

/** Amounts at settlement, excluding tips. Older receipts can lack a reliable split by line. */
export async function settledFamilies(
  tx: Tx,
  fromAt: Date,
  toAt: Date,
  staffId: string | undefined,
): Promise<SalesFamilyTotal[]> {
  const staff = staffId ? sql`and c.staff_id = ${staffId}` : sql``;
  const rows = await tx.execute<{
    family: SalesFamilyTotal["family"];
    amount: string | number;
    tax: string | number;
  }>(sql`
    with receipts as (
      select c.id, c.subtotal_cents, c.discount_cents, c.tax_cents, c.fulfilled_at
      from checkout c
      where c.fulfilled_at >= ${fromAt} and c.fulfilled_at < ${toAt} ${staff}
    ), line_values as (
      select l.checkout_id,
        case when l.kind in (${lineFamilies})
          then l.kind else 'other' end as family,
        l.quantity * l.unit_amount_cents::bigint as gross,
        l.discount_cents::bigint as discount,
        l.tax_cents::bigint as tax,
        a.amount_adjustment,
        a.tax_adjustment
      from receipts c join checkout_line l on l.checkout_id = c.id
      cross join lateral (
        select coalesce(sum(pr.allocated_cents::bigint - pr.amount_cents), 0) as amount_adjustment,
          coalesce(sum(pr.tax_cents::bigint - l.tax_cents), 0) as tax_adjustment
        from pass_redemption pr
        where l.kind = 'service' and pr.checkout_id = c.id and pr.checkout_line_id = l.id
          and ${redeemedAtSettlement}
      ) a
    ), checked_receipts as (
      select r.id, r.subtotal_cents, r.discount_cents, r.tax_cents,
        coalesce(
          sum(l.gross) = r.subtotal_cents
          and sum(l.discount) = r.discount_cents
          and sum(l.tax) = r.tax_cents
          and bool_and(l.discount between 0 and l.gross and l.tax between 0 and l.gross - l.discount),
          false
        ) as matches_lines,
        coalesce(sum(l.amount_adjustment), 0) as amount_adjustment
      from receipts r left join line_values l on l.checkout_id = r.id
      group by r.id, r.subtotal_cents, r.discount_cents, r.tax_cents
    ), values_by_family as (
      select l.family, l.gross - l.discount + l.amount_adjustment as amount, l.tax + l.tax_adjustment as tax
      from line_values l join checked_receipts r on r.id = l.checkout_id
      where r.matches_lines
      union all
      select 'unallocated', r.subtotal_cents - r.discount_cents + r.amount_adjustment,
        r.tax_cents
      from checked_receipts r where not r.matches_lines
    )
    select family, sum(amount)::bigint as amount, sum(tax)::bigint as tax
    from values_by_family
    group by family
    order by array_position(array[${familyOrder}]::text[], family)
  `);

  return rows.map((row) => ({
    family: row.family,
    amountCents: Number(row.amount),
    taxCents: Number(row.tax),
  }));
}
