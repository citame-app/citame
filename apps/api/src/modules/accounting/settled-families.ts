import { type SalesFamilyTotal, type SettledSaleItem, salesFamilySchema } from "@sob/contracts";
import { type SQL, sql } from "drizzle-orm";
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
export async function settledSales(tx: Tx, fromAt: Date, toAt: Date, scope: SQL) {
  const rows = await tx.execute<{
    family: SalesFamilyTotal["family"] | null;
    detail: boolean;
    item_id: string | null;
    name: string | null;
    quantity: string | number | null;
    amount: string | number;
    tax: string | number;
    tips: string | number;
  }>(sql`
    with receipts as (
      select c.id, c.subtotal_cents, c.discount_cents, c.tax_cents, c.total_cents, c.tip_cents, c.fulfilled_at
      from checkout c
      where c.fulfilled_at >= ${fromAt} and c.fulfilled_at < ${toAt} ${scope}
    ), line_values as (
      select l.checkout_id,
        case when l.kind in (${lineFamilies})
          then l.kind else 'other' end as family,
        case l.kind
          when 'service' then l.service_id
          when 'product' then l.product_id
          when 'package_purchase' then pc.plan_id
          when 'membership_period' then pc.plan_id
        end as item_id,
        case when l.kind in ('service', 'product', 'custom', 'package_purchase', 'membership_period')
          then l.description end as name,
        l.quantity,
        l.quantity * l.unit_amount_cents::bigint as gross,
        l.discount_cents::bigint as discount,
        l.tax_cents::bigint as tax,
        a.amount_adjustment,
        a.tax_adjustment
      from receipts c join checkout_line l on l.checkout_id = c.id
      left join pass_period pp on pp.id = l.pass_period_id
      left join pass_contract pc on pc.id = pp.contract_id
      cross join lateral (
        select coalesce(sum(pr.allocated_cents::bigint - pr.amount_cents), 0) as amount_adjustment,
          coalesce(sum(pr.tax_cents::bigint - l.tax_cents), 0) as tax_adjustment
        from pass_redemption pr
        where l.kind = 'service' and pr.checkout_id = c.id and pr.checkout_line_id = l.id
          and ${redeemedAtSettlement}
      ) a
    ), checked_receipts as (
      select r.id, r.subtotal_cents, r.discount_cents, r.tax_cents, r.total_cents, r.tip_cents,
        coalesce(
          sum(l.gross) = r.subtotal_cents
          and sum(l.discount) = r.discount_cents
          and sum(l.tax) = r.tax_cents
          and bool_and(l.discount between 0 and l.gross and l.tax between 0 and l.gross - l.discount),
          false
        ) as matches_lines,
        coalesce(sum(l.amount_adjustment), 0) as amount_adjustment,
        coalesce(sum(l.tax_adjustment), 0) as tax_adjustment,
        coalesce(bool_or(l.family in ('gift_card', 'package_purchase', 'membership_period')), false) as issues_value
      from receipts r left join line_values l on l.checkout_id = r.id
      group by r.id, r.subtotal_cents, r.discount_cents, r.tax_cents, r.total_cents, r.tip_cents
    ), settled_values as (
      select l.family, l.item_id, l.name, l.quantity,
        l.gross - l.discount + l.amount_adjustment as amount, l.tax + l.tax_adjustment as tax
      from line_values l join checked_receipts r on r.id = l.checkout_id
      where r.matches_lines
      union all
      select 'unallocated', null, null, null, r.subtotal_cents - r.discount_cents + r.amount_adjustment,
        r.tax_cents
      from checked_receipts r where not r.matches_lines
    )
    select family, detail, item_id, name, quantity, amount, tax, tips
    from (
      select family, grouping(item_id) = 0 as detail, item_id, name, sum(quantity)::bigint as quantity,
        sum(amount)::bigint as amount, sum(tax)::bigint as tax, 0::bigint as tips
      from settled_values group by grouping sets ((family), (family, item_id, name))
      union all
      select null, false, null, null, null, coalesce(sum(total_cents + amount_adjustment), 0)::bigint,
        coalesce(sum(tax_cents + case when matches_lines then tax_adjustment else 0 end), 0)::bigint,
        coalesce(sum(tip_cents), 0)::bigint
      from checked_receipts where not issues_value
    ) totals
    order by array_position(array[${familyOrder}]::text[], family), detail, amount desc, name, item_id
  `);

  const summary = rows.find((row) => row.family === null);
  return {
    soldCents: Number(summary?.amount ?? 0),
    includedTaxCents: Number(summary?.tax ?? 0),
    tipsCents: Number(summary?.tips ?? 0),
    settledByFamily: rows.flatMap((row): SalesFamilyTotal[] =>
      row.family === null || row.detail
        ? []
        : [{ family: row.family, amountCents: Number(row.amount), taxCents: Number(row.tax) }],
    ),
    settledByItem: rows.flatMap((row): SettledSaleItem[] =>
      row.family !== null && row.detail
        ? [
            {
              family: row.family,
              itemId: row.item_id,
              name: row.name,
              quantity: row.quantity === null ? null : Number(row.quantity),
              amountCents: Number(row.amount),
              taxCents: Number(row.tax),
            },
          ]
        : [],
    ),
  };
}
