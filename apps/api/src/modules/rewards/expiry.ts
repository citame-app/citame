import { checkout, checkoutPayment, checkoutReward, type Database } from "@sob/db";
import { and, eq, sql } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { releaseCheckoutInventory } from "../inventory/reservations";
import { releaseCheckoutReward } from "./value";

export async function expireRewardReservations(db: Database, now = new Date(), limit = 100) {
  const rows = await db
    .select({ checkoutId: checkoutReward.checkoutId })
    .from(checkoutReward)
    .where(
      and(
        eq(checkoutReward.state, "held"),
        sql`${checkoutReward.expiresAt} <= ${now}`,
        sql`exists (select 1 from checkout c where c.id=${checkoutReward.checkoutId} and (c.status='void' or (c.status='open' and c.fulfilled_at is null and c.appointment_id is null and not exists(select 1 from checkout_payment p where p.checkout_id=c.id and p.status<>'failed'))))`,
      ),
    )
    .limit(limit);
  let expired = 0;
  for (const row of rows)
    expired += await db.transaction(async (tx) => {
      const [sale] = await tx
        .select()
        .from(checkout)
        .where(eq(checkout.id, row.checkoutId))
        .for("update", { skipLocked: true });
      if (
        !sale ||
        sale.fulfilledAt ||
        sale.appointmentId ||
        !["open", "void"].includes(sale.status)
      )
        return 0;
      const [r] = await tx
        .select()
        .from(checkoutReward)
        .where(eq(checkoutReward.checkoutId, sale.id));
      if (r?.state !== "held" || r.expiresAt > now) return 0;
      const payments = await tx
        .select({ status: checkoutPayment.status })
        .from(checkoutPayment)
        .where(eq(checkoutPayment.checkoutId, sale.id));
      if (sale.status !== "void" && payments.some((p) => p.status !== "failed")) return 0;
      await releaseCheckoutInventory(tx, sale.id);
      await releaseCheckoutReward(tx, sale.id, now);
      await tx.update(checkout).set({ status: "void" }).where(eq(checkout.id, sale.id));
      await recordAudit(tx, {
        actorUserId: null,
        action: "rewards.receipt_expired",
        entity: "checkout",
        entityId: sale.id,
      });
      return 1;
    });
  return expired;
}
