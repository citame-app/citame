import { needsFinalPrice, type RevenueForecast, servicePriceTypeSchema } from "@sob/contracts";
import { sql } from "drizzle-orm";
import type { Tx } from "../../tx";

const provisionalPriceTypes = sql.join(
  servicePriceTypeSchema.options.filter(needsFinalPrice).map((kind) => sql`${kind}`),
  sql`, `,
);

/** Forecast the service value of the scheduled work as of this report, regardless of tender. */
export async function reportRevenueForecast(
  tx: Tx,
  range: { fromAt: Date; toAt: Date; timezone: string; staffId?: string; clientId?: string },
): Promise<RevenueForecast> {
  const asOf = new Date().toISOString();
  const { fromAt, toAt, timezone, staffId, clientId } = range;
  if (toAt.getTime() <= Date.parse(asOf)) return { asOf, rows: [] };
  const staff = staffId ? sql`and a.staff_id = ${staffId}` : sql``;
  const client = clientId
    ? sql`and a.client_id in (select client_identity_ids(${clientId}::uuid))`
    : sql``;
  const rows = await tx.execute<{
    day: string;
    currency: string | null;
    lines: number;
    amount: string | number | null;
  }>(sql`
    with scoped as (
      select a.id, (a.starts_at at time zone ${timezone})::date as day
      from appointment a
      where a.deleted_at is null and a.status = 'booked'
        and a.starts_at >= greatest(${fromAt}::timestamptz, ${asOf}::timestamptz)
        and a.starts_at < ${toAt}::timestamptz
        ${staff} ${client}
    ), booked_services as (
      select aps.appointment_id, min(aps.currency) as currency, count(distinct aps.currency) as currencies,
        bool_or(aps.source_unpriced and aps.reviewed_price_cents is null) as unpriced_import,
        bool_or(aps.price_type in (${provisionalPriceTypes}) and aps.reviewed_price_cents is null) as provisional,
        sum(coalesce(aps.reviewed_price_cents, aps.price_cents)) as booked_amount,
        array_agg(s.identity order by s.identity) as service_identities
      from scoped a join appointment_service aps on aps.appointment_id = a.id
      cross join lateral (select jsonb_build_array(aps.service_id, case when aps.service_id is null then aps.name end)::text as identity) s
      group by aps.appointment_id
    ), receipt_services as (
      select c.appointment_id, c.currency,
        sum(l.unit_amount_cents::bigint - l.discount_cents) as amount,
        bool_and(not l.price_pending and l.quantity = 1 and l.discount_cents between 0 and l.unit_amount_cents) as is_final,
        array_agg(s.identity order by s.identity) as service_identities
      from scoped a join checkout c on c.appointment_id = a.id and c.status <> 'void'
      join checkout_line l on l.checkout_id = c.id and l.kind = 'service'
      cross join lateral (select jsonb_build_array(l.service_id, case when l.service_id is null then l.description end)::text as identity) s
      group by c.appointment_id, c.currency
    ), values_by_appointment as (
      select a.day, b.currency,
        case when b.currencies <> 1 or b.unpriced_import then null
          when r.is_final and r.currency = b.currency and r.service_identities = b.service_identities then r.amount
          when not b.provisional then b.booked_amount
        end as amount
      from scoped a
      left join booked_services b on b.appointment_id = a.id
      left join receipt_services r on r.appointment_id = a.id
    )
    select day::text, case when amount is not null then currency end as currency,
      count(*)::int as lines, sum(amount)::bigint as amount
    from values_by_appointment
    group by day, case when amount is not null then currency end
    order by day, currency nulls last
  `);
  return {
    asOf,
    rows: rows.map(({ day, currency, lines, amount }) =>
      currency !== null && amount !== null
        ? { date: day, currency, appointmentLines: lines, amountCents: Number(amount) }
        : { date: day, currency: null, appointmentLines: lines, amountCents: null },
    ),
  };
}
