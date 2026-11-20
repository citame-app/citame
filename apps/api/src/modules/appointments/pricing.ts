import type { BookingPrice } from "@sob/contracts";
import { checkout, checkoutLine, type Database } from "@sob/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
/** Original online-promotion service totals; retail items and tips never inflate a visit price. */
export async function loadBookingPrices(db: Pick<Database, "select">, ids: string[]) {
  const prices = new Map<string, BookingPrice>();
  if (!ids.length) return prices;
  const rows = await db
    .select({
      appointmentId: checkout.appointmentId,
      currency: checkout.currency,
      pricingVersion: checkout.pricingVersion,
      subtotalCents:
        sql<number>`sum(${checkoutLine.quantity}::bigint*${checkoutLine.unitAmountCents})`.mapWith(
          Number,
        ),
      discountCents: sql<number>`sum(${checkoutLine.discountCents})`.mapWith(Number),
    })
    .from(checkout)
    .innerJoin(checkoutLine, eq(checkoutLine.checkoutId, checkout.id))
    .where(
      and(
        inArray(checkout.appointmentId, ids),
        eq(checkoutLine.kind, "service"),
        sql`(${checkout.idempotencyKey} = 'booking-promotion-' || ${checkout.appointmentId}::text or ${checkout.pricingVersion}>1)`,
      ),
    )
    .groupBy(checkout.id)
    .orderBy(desc(checkout.createdAt), desc(checkout.id));
  for (const row of rows)
    if (row.appointmentId && row.currency === "EUR" && !prices.has(row.appointmentId))
      prices.set(row.appointmentId, {
        subtotalCents: row.subtotalCents,
        discountCents: row.discountCents,
        totalCents: row.subtotalCents - row.discountCents,
        currency: row.currency,
        ...(row.pricingVersion > 1 ? { finalized: true } : {}),
      });
  return prices;
}
