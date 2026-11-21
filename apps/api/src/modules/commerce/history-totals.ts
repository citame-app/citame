import type { CheckoutGroupTotal, CheckoutHistoryGroup } from "@sob/contracts";
import { checkout, checkoutPayment, checkoutRefund } from "@sob/db";
import { and, eq, gte, inArray, lt, type SQL, sql } from "drizzle-orm";
import type { Tx } from "../../tx";
import { completedRefundStatus, recordedPaymentStatuses } from "./money";

export async function checkoutGroupTotals(
  tx: Tx,
  where: SQL | undefined,
  group: CheckoutHistoryGroup,
  timezone: string,
  visible: ReadonlyArray<{ createdAt: Date }>,
): Promise<CheckoutGroupTotal[]> {
  const periodStart = (instant: Date) => {
    const day = Temporal.Instant.fromEpochMilliseconds(instant.getTime())
      .toZonedDateTimeISO(timezone)
      .toPlainDate();
    return group === "month" ? day.with({ day: 1 }) : day;
  };
  const periods = [
    ...new Set(visible.map(({ createdAt }) => periodStart(createdAt).toString())),
  ].sort();
  const first = periods[0];
  const last = periods.at(-1);
  if (!first || !last) return [];

  // Use an indexed UTC range with room for any offset, then require the exact local periods.
  // Local dates can run backwards when a clock moves back across midnight.
  const start = Temporal.PlainDate.from(first).subtract({ days: 1 });
  const end = Temporal.PlainDate.from(last)
    .add(group === "month" ? { months: 1 } : { days: 1 })
    .add({ days: 1 });
  const utcBoundary = (date: Temporal.PlainDate) =>
    new Date(date.toZonedDateTime("UTC").epochMilliseconds);
  const period = sql<string>`to_char(date_trunc(${group}, timezone(${timezone}, ${checkout.createdAt})), 'YYYY-MM-DD')`;
  const returned = tx
    .select({ amount: sql`sum(${checkoutRefund.amountCents})`.as("amount") })
    .from(checkoutRefund)
    .where(
      and(
        eq(checkoutRefund.paymentId, checkoutPayment.id),
        eq(checkoutRefund.status, completedRefundStatus),
      ),
    )
    .as("returned");
  const tender = tx
    .select({
      paid: sql`sum(${checkoutPayment.amountCents}) filter (where ${inArray(checkoutPayment.status, recordedPaymentStatuses)})`.as(
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
      period,
      receipts: sql<number>`count(*)::int`,
      paidCents: sql`sum(coalesce(${tender.paid}, 0))`.mapWith(Number),
      refundedCents: sql`sum(coalesce(${tender.refunded}, 0))`.mapWith(Number),
    })
    .from(checkout)
    .leftJoinLateral(tender, sql`true`)
    .where(
      and(
        where,
        gte(checkout.createdAt, utcBoundary(start)),
        lt(checkout.createdAt, utcBoundary(end)),
        inArray(period, periods),
      ),
    )
    .groupBy(sql`1`)
    .orderBy(sql`1 desc`);
}
