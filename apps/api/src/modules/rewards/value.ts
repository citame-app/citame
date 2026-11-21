import {
  checkout,
  checkoutLine,
  checkoutPayment,
  checkoutRefund,
  checkoutReward,
  checkoutRewardLot,
  type Database,
  loyaltyLot,
  loyaltyMovement,
  passRedemption,
} from "@sob/db";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { requirePermission } from "../../auth/policy";
import type { Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import type { Tx } from "../../tx";
import { getCheckoutInTransaction, saleRow } from "../commerce/service";
import { releaseCheckoutInventory } from "../inventory/reservations";
import { getLoyaltyPolicy, lockRewardClient } from "./accounts";
import { syncCheckoutStamp } from "./stamps";

const floorRatio = (amount: number, part: number, total: number) =>
  total <= 0 ? 0 : Number((BigInt(amount) * BigInt(part)) / BigInt(total));
type Lot = typeof loyaltyLot.$inferSelect;
async function expireLot(tx: Tx, lot: Lot, now: Date): Promise<Lot> {
  if (!lot.expiresAt || lot.expiresAt > now || !lot.remainingPoints) return lot;
  const [updated] = await tx
    .update(loyaltyLot)
    .set({ remainingPoints: 0, expiredPoints: lot.expiredPoints + lot.remainingPoints })
    .where(eq(loyaltyLot.id, lot.id))
    .returning();
  await tx
    .insert(loyaltyMovement)
    .values({
      clientId: lot.clientId,
      lotId: lot.id,
      checkoutId: lot.checkoutId,
      kind: "expiry",
      points: -lot.remainingPoints,
      eventKey: `loyalty-expiry:${lot.id}`,
      createdAt: lot.expiresAt,
    })
    .onConflictDoNothing();
  return updated ?? lot;
}
type CheckoutValueRows = {
  lines: (typeof checkoutLine.$inferSelect)[];
  payments: (typeof checkoutPayment.$inferSelect)[];
  refunds: (typeof checkoutRefund.$inferSelect)[];
};

/** Gross customer value; prepaid services earn their original funded allocation, never face value. */
async function retainedValue(
  tx: Tx | Database,
  sale: typeof checkout.$inferSelect,
  loaded?: CheckoutValueRows,
) {
  const lines =
    loaded?.lines ??
    (await tx.select().from(checkoutLine).where(eq(checkoutLine.checkoutId, sale.id)));
  const redemptions = await tx
    .select()
    .from(passRedemption)
    .where(eq(passRedemption.checkoutId, sale.id))
    .orderBy(desc(passRedemption.createdAt), desc(passRedemption.id));
  const byLine = new Map<string, typeof passRedemption.$inferSelect>();
  for (const r of redemptions) if (!byLine.has(r.checkoutLineId)) byLine.set(r.checkoutLineId, r);
  const paid =
    loaded?.payments ??
    (await tx.select().from(checkoutPayment).where(eq(checkoutPayment.checkoutId, sale.id)));
  const refunds =
    loaded?.refunds ??
    (paid.length
      ? await tx
          .select()
          .from(checkoutRefund)
          .where(
            and(
              inArray(
                checkoutRefund.paymentId,
                paid.map((p) => p.id),
              ),
              eq(checkoutRefund.status, "succeeded"),
            ),
          )
      : []);
  const money = paid.filter((p) => !["package", "membership"].includes(p.method));
  const net = Math.max(
    0,
    money
      .filter((p) => ["succeeded", "reconciliation"].includes(p.status))
      .reduce((sum, p) => sum + p.amountCents, 0) -
      refunds
        .filter((r) => r.status === "succeeded" && money.some((p) => p.id === r.paymentId))
        .reduce((sum, r) => sum + r.amountCents, 0),
  );
  const face = [...byLine.values()].reduce((sum, r) => sum + r.amountCents, 0);
  const cashRequired = Math.max(0, sale.totalCents - face);
  const cashRetained = Math.min(cashRequired, net);
  let eligibleOriginal = 0;
  let eligibleRetained = 0;
  const serviceRetained = new Map<string, number>();
  for (const line of lines) {
    if (!["service", "product", "custom"].includes(line.kind)) continue;
    const r = byLine.get(line.id);
    const original = r?.allocatedCents ?? line.quantity * line.unitAmountCents - line.discountCents;
    eligibleOriginal += original;
    const retained = r
      ? r.refundedAt
        ? 0
        : r.allocatedCents
      : floorRatio(original, cashRetained, cashRequired);
    eligibleRetained += retained;
    if (line.kind === "service" && line.serviceId)
      serviceRetained.set(line.serviceId, (serviceRetained.get(line.serviceId) ?? 0) + retained);
  }
  const prepaidOriginal = [...byLine.values()].reduce((sum, r) => sum + r.allocatedCents, 0);
  const prepaidRetained = [...byLine.values()]
    .filter((r) => !r.refundedAt)
    .reduce((sum, r) => sum + r.allocatedCents, 0);
  return {
    eligibleOriginal,
    eligibleRetained,
    serviceRetained,
    totalOriginal: cashRequired + prepaidOriginal,
    totalRetained: cashRetained + prepaidRetained,
  };
}

export async function canReturnCheckoutPoints(
  tx: Tx | Database,
  sale: typeof checkout.$inferSelect,
  reward: Pick<
    typeof checkoutReward.$inferSelect,
    "kind" | "state" | "pointsUsed" | "returnedPoints"
  > | null,
  loaded?: CheckoutValueRows,
) {
  if (
    reward?.kind !== "points" ||
    reward.state !== "applied" ||
    reward.returnedPoints >= reward.pointsUsed ||
    !sale.fulfilledAt
  )
    return false;
  return (await retainedValue(tx, sale, loaded)).totalRetained === 0;
}
/** Return oldest allocations first so repeated partial returns are monotonic and cent-exact. */
async function restoreRedemption(
  tx: Tx,
  reward: typeof checkoutReward.$inferSelect,
  target: number,
  now: Date,
) {
  if (reward.kind !== "points" || target <= reward.returnedPoints) return;
  const allocations = await tx
    .select({ allocation: checkoutRewardLot, lot: loyaltyLot })
    .from(checkoutRewardLot)
    .innerJoin(loyaltyLot, eq(loyaltyLot.id, checkoutRewardLot.lotId))
    .where(eq(checkoutRewardLot.rewardId, reward.id))
    .orderBy(asc(loyaltyLot.expiresAt), asc(loyaltyLot.createdAt), asc(loyaltyLot.id));
  let needed = target;
  let restored = 0;
  for (const { allocation, lot: before } of allocations) {
    const total = Math.min(needed, allocation.points);
    needed -= total;
    const delta = total - allocation.returnedPoints;
    if (!delta) continue;
    const lot = await expireLot(tx, before, now);
    const debt = Math.min(delta, lot.revokedSpentPoints);
    const valid = delta - debt;
    const expired = Boolean(lot.expiresAt && lot.expiresAt <= now);
    await tx
      .update(loyaltyLot)
      .set({
        spentPoints: lot.spentPoints - delta,
        revokedSpentPoints: lot.revokedSpentPoints - debt,
        revokedUnusedPoints: lot.revokedUnusedPoints + debt,
        remainingPoints: lot.remainingPoints + (expired ? 0 : valid),
        expiredPoints: lot.expiredPoints + (expired ? valid : 0),
      })
      .where(eq(loyaltyLot.id, lot.id));
    await tx
      .update(checkoutRewardLot)
      .set({ returnedPoints: total })
      .where(and(eq(checkoutRewardLot.rewardId, reward.id), eq(checkoutRewardLot.lotId, lot.id)));
    restored += debt + (expired ? 0 : valid);
  }
  await tx
    .update(checkoutReward)
    .set({ returnedPoints: target })
    .where(eq(checkoutReward.id, reward.id));
  if (restored)
    await tx
      .insert(loyaltyMovement)
      .values({
        clientId: reward.clientId,
        checkoutId: reward.checkoutId,
        kind: "redemption_return",
        points: restored,
        eventKey: `reward-return:${reward.id}:${target}`,
      })
      .onConflictDoNothing();
  await recordAudit(tx, {
    actorUserId: null,
    action: "rewards.points_returned",
    entity: "checkout",
    entityId: reward.checkoutId,
    metadata: { returnedPoints: target - reward.returnedPoints, restoredBalancePoints: restored },
  });
}
export async function releaseCheckoutReward(tx: Tx, checkoutId: string, now = new Date()) {
  const [reward] = await tx
    .select()
    .from(checkoutReward)
    .where(eq(checkoutReward.checkoutId, checkoutId));
  if (reward?.state !== "held") return;
  await lockRewardClient(tx, reward.clientId, true);
  await restoreRedemption(tx, reward, reward.pointsUsed, now);
  await tx
    .update(checkoutReward)
    .set({ state: "released" })
    .where(eq(checkoutReward.id, reward.id));
  await recordAudit(tx, {
    actorUserId: null,
    action: "rewards.reservation_released",
    entity: "checkout",
    entityId: checkoutId,
  });
}
async function revokeAward(tx: Tx, before: Lot, retained: number, now: Date) {
  const lot = await expireLot(tx, before, now);
  const desired =
    lot.grantedPoints -
    floorRatio(lot.grantedPoints, Math.min(lot.basisCents, retained), lot.basisCents);
  const current = lot.revokedUnusedPoints + lot.revokedSpentPoints;
  if (desired <= current) return;
  let delta = desired - current;
  const unused = Math.min(delta, lot.remainingPoints);
  delta -= unused;
  const expired = Math.min(delta, lot.expiredPoints);
  delta -= expired;
  await tx
    .update(loyaltyLot)
    .set({
      remainingPoints: lot.remainingPoints - unused,
      expiredPoints: lot.expiredPoints - expired,
      revokedUnusedPoints: lot.revokedUnusedPoints + unused + expired,
      revokedSpentPoints: lot.revokedSpentPoints + delta,
    })
    .where(eq(loyaltyLot.id, lot.id));
  if (unused + delta)
    await tx.insert(loyaltyMovement).values({
      clientId: lot.clientId,
      lotId: lot.id,
      checkoutId: lot.checkoutId,
      kind: "refund_adjustment",
      points: -(unused + delta),
      eventKey: `loyalty-revoke:${lot.id}:${desired}`,
    });
  await recordAudit(tx, {
    actorUserId: null,
    action: "rewards.earnings_reversed",
    entity: "checkout",
    entityId: lot.checkoutId,
    metadata: { revokedPoints: desired - current, debtPoints: delta },
  });
}
/** Under the receipt lock. Only the initial fulfillment may award; later calls only reverse. */
export async function syncCheckoutRewards(
  tx: Tx,
  checkoutId: string,
  initial = false,
  now = new Date(),
) {
  const [sale] = await tx.select().from(checkout).where(eq(checkout.id, checkoutId));
  if (!sale?.clientId) return;
  if (!sale.fulfilledAt) {
    if (sale.status !== "refunded") return;
    const [reward] = await tx
      .select()
      .from(checkoutReward)
      .where(eq(checkoutReward.checkoutId, checkoutId));
    if (reward?.state !== "held") return;
    const unresolved = await tx
      .select({ id: checkoutPayment.id })
      .from(checkoutPayment)
      .where(and(eq(checkoutPayment.checkoutId, checkoutId), eq(checkoutPayment.status, "pending")))
      .limit(1);
    if (unresolved.length) return;
    await releaseCheckoutInventory(tx, checkoutId);
    await releaseCheckoutReward(tx, checkoutId, now);
    await tx.update(checkout).set({ status: "void" }).where(eq(checkout.id, checkoutId));
    return;
  }
  const client = await lockRewardClient(tx, sale.clientId, true);
  const value = await retainedValue(tx, sale);
  await syncCheckoutStamp(
    tx,
    { id: sale.id, clientId: sale.clientId, appointmentId: sale.appointmentId },
    value,
    initial,
    now,
  );
  const [reward] = await tx
    .select()
    .from(checkoutReward)
    .where(eq(checkoutReward.checkoutId, checkoutId));
  if (reward && reward.state !== "released") {
    if (reward.state === "held")
      await tx
        .update(checkoutReward)
        .set({ state: "applied" })
        .where(eq(checkoutReward.id, reward.id));
    if (value.totalOriginal > 0) {
      const target = floorRatio(
        reward.pointsUsed,
        Math.max(0, value.totalOriginal - value.totalRetained),
        value.totalOriginal,
      );
      await restoreRedemption(tx, reward, target, now);
    }
  }
  const [existing] = await tx
    .select()
    .from(loyaltyLot)
    .where(eq(loyaltyLot.checkoutId, checkoutId));
  if (existing) return revokeAward(tx, existing, value.eligibleRetained, now);
  if (!initial || client.deletedAt) return;
  const policy = await getLoyaltyPolicy(tx);
  if (!policy.enabled || !value.eligibleRetained) return;
  const points = Math.min(
    1000000000,
    Math.floor(value.eligibleRetained / policy.earnEveryCents) * policy.pointsPerStep,
  );
  if (!points) return;
  const [lot] = await tx
    .insert(loyaltyLot)
    .values({
      clientId: sale.clientId,
      checkoutId,
      grantedPoints: points,
      remainingPoints: points,
      basisCents: value.eligibleRetained,
      policyVersion: policy.version,
      expiresAt: policy.expiryDays ? new Date(now.getTime() + policy.expiryDays * 86400000) : null,
    })
    .returning();
  if (!lot) throw new Error("Loyalty award insert failed");
  await tx.insert(loyaltyMovement).values({
    clientId: sale.clientId,
    lotId: lot.id,
    checkoutId,
    kind: "earn",
    points,
    eventKey: `loyalty-earn:${checkoutId}`,
  });
}
export async function expireLoyaltyLots(db: Database, now = new Date(), limit = 100) {
  const rows = await db
    .select({ id: loyaltyLot.id, clientId: loyaltyLot.clientId })
    .from(loyaltyLot)
    .where(and(sql`${loyaltyLot.remainingPoints}>0`, sql`${loyaltyLot.expiresAt}<=${now}`))
    .limit(limit);
  for (const row of rows)
    await db.transaction(async (tx) => {
      await lockRewardClient(tx, row.clientId, true);
      const [lot] = await tx
        .select()
        .from(loyaltyLot)
        .where(eq(loyaltyLot.id, row.id))
        .for("update");
      if (lot) await expireLot(tx, lot, now);
    });
  return rows.length;
}

export async function returnCheckoutPoints(
  tx: Tx,
  id: string,
  reason: string,
  principal: Principal,
) {
  requirePermission(principal, "refunds");
  const sale = await saleRow(tx, id, principal, true);
  const [reward] = await tx.select().from(checkoutReward).where(eq(checkoutReward.checkoutId, id));
  if (reward?.kind !== "points")
    throw new DomainError("invalid_state", "This receipt has no points to return");
  if (reward.returnedPoints === reward.pointsUsed)
    return getCheckoutInTransaction(tx, id, principal);
  if (!sale.fulfilledAt || reward.state !== "applied")
    throw new DomainError("invalid_state", "Void an unpaid reward reservation instead");
  if (!(await canReturnCheckoutPoints(tx, sale, reward)))
    throw new DomainError(
      "invalid_state",
      "Return the captured payments before returning all points",
    );
  await lockRewardClient(tx, reward.clientId, true);
  await restoreRedemption(tx, reward, reward.pointsUsed, new Date());
  await tx.update(checkout).set({ status: "refunded" }).where(eq(checkout.id, id));
  await recordAudit(tx, {
    actorUserId: principal.userId,
    action: "rewards.full_points_return",
    entity: "checkout",
    entityId: id,
    metadata: { reason, points: reward.pointsUsed },
  });
  return getCheckoutInTransaction(tx, id, principal);
}

export async function releaseUnfulfilledAppointmentRewards(
  tx: Tx,
  appointmentId: string,
  actorUserId: string | null,
) {
  const rows = await tx
    .select({ sale: checkout })
    .from(checkout)
    .innerJoin(checkoutReward, eq(checkoutReward.checkoutId, checkout.id))
    .where(and(eq(checkout.appointmentId, appointmentId), eq(checkoutReward.state, "held")));
  for (const { sale } of rows) {
    if (sale.fulfilledAt) continue;
    await releaseCheckoutInventory(tx, sale.id);
    await releaseCheckoutReward(tx, sale.id);
    await tx.update(checkout).set({ status: "void" }).where(eq(checkout.id, sale.id));
    await recordAudit(tx, {
      actorUserId,
      action: "rewards.cancelled_appointment",
      entity: "checkout",
      entityId: sale.id,
    });
  }
}
