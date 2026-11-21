import type { CheckoutGroupTotal, CheckoutHistoryGroup } from "@sob/contracts";
import { checkout, checkoutPayment, checkoutRefund } from "@sob/db";
import { and, eq, gte, lt, type SQL, sql } from "drizzle-orm";
import type { Tx } from "../../tx";

export async function checkoutGroupTotals(
  tx: Tx,
  where: SQL | undefined,
  group: CheckoutHistoryGroup,
  timezone: string,
  visible: ReadonlyArray<{ createdAt: Date }>,
): Promise<CheckoutGroupTotal[]> {
  const newest = visible.at(0);
  const oldest = visible.at(-1);
  if (!newest || !oldest) return [];

  const periodStart = (instant: Date) => {
    const day = Temporal.Instant.fromEpochMilliseconds(instant.getTime())
      .toZonedDateTimeISO(timezone)
      .toPlainDate();
    return group === "month" ? day.with({ day: 1 }) : day;
  };
  const start = periodStart(oldest.createdAt);
  const end = periodStart(newest.createdAt).add(group === "month" ? { months: 1 } : { days: 1 });
  const dayBoundary = (day: Temporal.PlainDate) =>
    new Date(day.toZonedDateTime(timezone).epochMilliseconds);

  const returned = tx
    .select({ amount: sql`sum(${checkoutRefund.amountCents})`.as("amount") })
    .from(checkoutRefund)
    .where(
      and(eq(checkoutRefund.paymentId, checkoutPayment.id), eq(checkoutRefund.status, "succeeded")),
    )
    .as("returned");
  const tender = tx
    .select({
      paid: sql`sum(${checkoutPayment.amountCents}) filter (where ${checkoutPayment.status} in ('succeeded', 'reconciliation'))`.as(
        "paid",
      ),
      refunded: sql`sum(${returned.amount})`.as("refunded"),
    })
    .from(checkoutPayment)
    .leftJoinLateral(returned, sql`true`)
    .where(eq(checkoutPayment.checkoutId, checkout.id))
    .as("tender");

  return tx
    .select({
      period: sql<string>`to_char(date_trunc(${group}, timezone(${timezone}, ${checkout.createdAt})), 'YYYY-MM-DD')`,
      receipts: sql<number>`count(*)::int`,
      paidCents: sql`sum(coalesce(${tender.paid}, 0))`.mapWith(Number),
      refundedCents: sql`sum(coalesce(${tender.refunded}, 0))`.mapWith(Number),
    })
    .from(checkout)
    .leftJoinLateral(tender, sql`true`)
    .where(
      and(
        where,
        gte(checkout.createdAt, dayBoundary(start)),
        lt(checkout.createdAt, dayBoundary(end)),
      ),
    )
    .groupBy(sql`1`)
    .orderBy(sql`1 desc`);
}
