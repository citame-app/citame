import type { PromotionCollection } from "@sob/contracts";
import { type SQL, sql } from "drizzle-orm";
import type { Tx } from "../../tx";
import { storedValuePaymentMethods } from "../commerce/money";
import { recordedCheckoutMovements } from "../commerce/report-movements";
import { confirmedBookingPromotionJoin } from "../rewards/booking-attribution";

const storedValueMethods = sql.join(
  storedValuePaymentMethods.map((method) => sql`${method}`),
  sql`, `,
);

export async function reportPromotionCollections(
  db: Tx,
  fromAt: Date,
  toAt: Date,
  scope: SQL,
): Promise<PromotionCollection[]> {
  const rows = await db.execute<{
    name: string;
    code: string;
    collected: string | number;
    refunded: string | number;
  }>(sql`
    with by_checkout as (
      select checkout_id,
        coalesce(sum(amount) filter (where not refund), 0) as collected,
        coalesce(sum(amount) filter (where refund), 0) as refunded
      from (${recordedCheckoutMovements(fromAt, toAt, scope)}) movements
      where method not in (${storedValueMethods})
      group by checkout_id
    )
    select promotion_reward.name, promotion_reward.code,
      sum(movements.collected)::bigint as collected, sum(movements.refunded)::bigint as refunded
    from by_checkout movements
    join checkout c on c.id = movements.checkout_id
    ${confirmedBookingPromotionJoin}
    group by promotion_reward.name, promotion_reward.code
    order by sum(movements.collected - movements.refunded) desc,
      promotion_reward.name, promotion_reward.code
  `);
  return rows.map(({ name, code, collected, refunded }) => {
    const collectedCents = Number(collected);
    const refundedCents = Number(refunded);
    return { name, code, collectedCents, refundedCents, netCents: collectedCents - refundedCents };
  });
}
