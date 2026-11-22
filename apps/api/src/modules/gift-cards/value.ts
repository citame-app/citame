import { randomUUID } from "node:crypto";
import {
  checkout,
  checkoutLine,
  checkoutPayment,
  checkoutRefund,
  giftCard,
  giftCardMovement,
} from "@sob/db";
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { recordAudit } from "../../audit";
import type { Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import type { Tx } from "../../tx";
import { giftCodeHash } from "./code";
export async function pendingGiftForCheckout(tx: Tx, id: string, principal: Principal) {
  const [row] = await tx.select().from(giftCard).where(eq(giftCard.id, id)).for("update");
  if (row?.status !== "pending" || row.createdBy !== principal.userId)
    throw new DomainError("not_found", "Pending gift card not found");
  const [assigned] = await tx
    .select({ id: checkoutLine.id })
    .from(checkoutLine)
    .where(eq(checkoutLine.giftCardId, id));
  if (assigned) throw new DomainError("invalid_state", "Gift card already has a purchase receipt");
  return row;
}
export async function activateCheckoutGifts(tx: Tx, checkoutId: string) {
  const lines = await tx
    .select({ giftCardId: checkoutLine.giftCardId })
    .from(checkoutLine)
    .where(and(eq(checkoutLine.checkoutId, checkoutId), isNotNull(checkoutLine.giftCardId)));
  for (const line of lines) {
    if (!line.giftCardId) continue;
    const [card] = await tx
      .select()
      .from(giftCard)
      .where(eq(giftCard.id, line.giftCardId))
      .for("update");
    if (card?.status !== "pending")
      throw new DomainError("invalid_state", "Gift card cannot be activated");
    await tx
      .update(giftCard)
      .set({ status: "active", balanceCents: card.amountCents, version: card.version + 1 })
      .where(eq(giftCard.id, card.id));
    await tx.insert(giftCardMovement).values({
      giftCardId: card.id,
      checkoutId,
      amountCents: card.amountCents,
      kind: "activation",
      eventKey: `activate-${checkoutId}`,
    });
    await recordAudit(tx, {
      actorUserId: null,
      action: "gift_card.activated",
      entity: "gift_card",
      entityId: card.id,
      metadata: { checkoutId, amountCents: card.amountCents },
    });
  }
  await syncCheckoutGiftRefunds(tx, checkoutId);
}
export async function voidCheckoutGifts(tx: Tx, checkoutId: string) {
  const lines = await tx
    .select({ id: checkoutLine.giftCardId })
    .from(checkoutLine)
    .where(and(eq(checkoutLine.checkoutId, checkoutId), isNotNull(checkoutLine.giftCardId)));
  const ids = lines.flatMap((line) => (line.id ? [line.id] : [])).sort();
  if (ids.length)
    await tx
      .select()
      .from(giftCard)
      .where(inArray(giftCard.id, ids))
      .orderBy(asc(giftCard.id))
      .for("update");
  for (const id of ids)
    await tx
      .update(giftCard)
      .set({ status: "void", version: sql`${giftCard.version} + 1` })
      .where(and(eq(giftCard.id, id), eq(giftCard.status, "pending")));
}
export async function redeemGift(
  tx: Tx,
  code: string,
  amountCents: number,
  paymentId: string,
  checkoutId: string,
  principal: Principal,
) {
  const [purchase] = await tx
    .select({ id: checkoutLine.id })
    .from(checkoutLine)
    .where(and(eq(checkoutLine.checkoutId, checkoutId), eq(checkoutLine.kind, "gift_card")))
    .limit(1);
  if (purchase) throw new DomainError("invalid_state", "A gift card cannot buy another gift card");
  const [card] = await tx
    .select()
    .from(giftCard)
    .where(eq(giftCard.codeHash, giftCodeHash(code)))
    .for("update");
  if (
    card?.status !== "active" ||
    (card.expiresAt && card.expiresAt.getTime() <= Date.now()) ||
    card.balanceCents - card.reservedCents < amountCents
  )
    throw new DomainError(
      "invalid_state",
      "Gift card is invalid, expired or has insufficient available value",
    );
  await tx
    .update(giftCard)
    .set({ balanceCents: card.balanceCents - amountCents, version: card.version + 1 })
    .where(eq(giftCard.id, card.id));
  await tx
    .update(checkoutPayment)
    .set({ giftCardId: card.id })
    .where(eq(checkoutPayment.id, paymentId));
  await tx.insert(giftCardMovement).values({
    giftCardId: card.id,
    checkoutId,
    paymentId,
    amountCents: -amountCents,
    kind: "redemption",
    eventKey: `redeem-${paymentId}`,
    createdBy: principal.userId,
  });
  await recordAudit(tx, {
    actorUserId: principal.userId,
    action: "gift_card.redeemed",
    entity: "gift_card",
    entityId: card.id,
    metadata: { checkoutId, paymentId, amountCents },
  });
}
/** Map cumulative cash refunds to revoked entitlement cents without rounding each refund. */
function revokedGiftValue(faceValue: number, purchasePrice: number, cashCents: number): number {
  const returned = Math.max(0, Math.min(purchasePrice, cashCents));
  const denominator = BigInt(purchasePrice);
  return Number((BigInt(returned) * BigInt(faceValue) + denominator - 1n) / denominator);
}

/** Checkout lock is held by callers. Gift-card locks serialize shared value across receipts. */
export async function syncCheckoutGiftRefunds(tx: Tx, checkoutId: string) {
  let closed = false;
  const lines = await tx
    .select({ id: checkoutLine.giftCardId, priceCents: checkoutLine.unitAmountCents })
    .from(checkoutLine)
    .where(and(eq(checkoutLine.checkoutId, checkoutId), isNotNull(checkoutLine.giftCardId)));
  if (lines.length) {
    const [sale] = await tx.select().from(checkout).where(eq(checkout.id, checkoutId));
    const payments = await tx
      .select()
      .from(checkoutPayment)
      .where(eq(checkoutPayment.checkoutId, checkoutId));
    const refunds = payments.length
      ? await tx
          .select()
          .from(checkoutRefund)
          .where(
            inArray(
              checkoutRefund.paymentId,
              payments.map((p) => p.id),
            ),
          )
      : [];
    const captured = payments
      .filter((p) => p.status === "succeeded" || p.status === "reconciliation")
      .reduce((sum, p) => sum + p.amountCents, 0);
    const excess = Math.max(0, captured - (sale?.totalCents ?? 0));
    const returned = refunds
      .filter((r) => r.status === "succeeded")
      .reduce((sum, r) => sum + r.amountCents, 0);
    const reservedRefunds = refunds
      .filter((r) => r.status !== "failed")
      .reduce((sum, r) => sum + r.amountCents, 0);
    for (const line of lines) {
      if (!line.id) continue;
      const [card] = await tx.select().from(giftCard).where(eq(giftCard.id, line.id)).for("update");
      if (!card) continue;
      if (card.status === "void") {
        closed = true;
        continue;
      }
      if (card.status === "pending") {
        if (
          captured > 0 &&
          returned >= captured &&
          !payments.some((payment) => payment.status === "pending")
        ) {
          await tx
            .update(giftCard)
            .set({ status: "void", version: card.version + 1 })
            .where(eq(giftCard.id, card.id));
          await recordAudit(tx, {
            actorUserId: null,
            action: "gift_card.purchase_cancelled",
            entity: "gift_card",
            entityId: card.id,
            metadata: { checkoutId },
          });
          closed = true;
        }
        continue;
      }
      if (line.priceCents <= 0) throw new Error("Gift purchase receipt has no price");
      const desiredReturned = revokedGiftValue(
        card.amountCents,
        line.priceCents,
        returned - excess,
      );
      const desiredReserved =
        revokedGiftValue(card.amountCents, line.priceCents, reservedRefunds - excess) -
        desiredReturned;
      const deduction = desiredReturned - card.purchaseRefundedCents;
      const balance = card.balanceCents - deduction;
      if (balance < desiredReserved || balance > card.amountCents)
        throw new DomainError(
          "invalid_state",
          "Gift card purchase value has already been spent or reserved",
        );
      const fullyReturned = returned - excess >= line.priceCents;
      if (!deduction && card.reservedCents === desiredReserved && !fullyReturned) continue;
      if (fullyReturned) closed = true;
      await tx
        .update(giftCard)
        .set({
          status: fullyReturned ? "void" : "active",
          balanceCents: balance,
          reservedCents: desiredReserved,
          purchaseRefundedCents: desiredReturned,
          version: card.version + 1,
        })
        .where(eq(giftCard.id, card.id));
      if (deduction)
        await tx.insert(giftCardMovement).values({
          giftCardId: card.id,
          checkoutId,
          amountCents: -deduction,
          kind: deduction > 0 ? "purchase_refund" : "purchase_refund_reversal",
          eventKey: randomUUID(),
        });
      await recordAudit(tx, {
        actorUserId: null,
        action: "gift_card.purchase_refund_adjusted",
        entity: "gift_card",
        entityId: card.id,
        metadata: { checkoutId, deductedCents: deduction, reservedCents: desiredReserved },
      });
    }
  }
  const refunds = await tx
    .select({ refund: checkoutRefund, payment: checkoutPayment })
    .from(checkoutRefund)
    .innerJoin(checkoutPayment, eq(checkoutPayment.id, checkoutRefund.paymentId))
    .where(
      and(
        eq(checkoutPayment.checkoutId, checkoutId),
        eq(checkoutPayment.method, "gift_card"),
        eq(checkoutRefund.status, "succeeded"),
      ),
    );
  const ids = [
    ...new Set(refunds.flatMap((r) => (r.payment.giftCardId ? [r.payment.giftCardId] : []))),
  ].sort();
  if (ids.length)
    await tx
      .select()
      .from(giftCard)
      .where(inArray(giftCard.id, ids))
      .orderBy(asc(giftCard.id))
      .for("update");
  for (const { refund, payment } of refunds) {
    if (!payment.giftCardId) throw new Error("Gift tender is missing its stored-value source");
    const eventKey = `redemption-refund-${refund.id}`;
    const [previous] = await tx
      .select({ id: giftCardMovement.id })
      .from(giftCardMovement)
      .where(
        and(
          eq(giftCardMovement.giftCardId, payment.giftCardId),
          eq(giftCardMovement.eventKey, eventKey),
        ),
      );
    if (previous) continue;
    await tx
      .update(giftCard)
      .set({
        balanceCents: sql`${giftCard.balanceCents} + ${refund.amountCents}`,
        version: sql`${giftCard.version} + 1`,
      })
      .where(eq(giftCard.id, payment.giftCardId));
    await tx.insert(giftCardMovement).values({
      giftCardId: payment.giftCardId,
      checkoutId,
      paymentId: payment.id,
      refundId: refund.id,
      amountCents: refund.amountCents,
      kind: "redemption_refund",
      eventKey,
      createdBy: refund.createdBy,
    });
    await recordAudit(tx, {
      actorUserId: refund.createdBy,
      action: "gift_card.redemption_refunded",
      entity: "gift_card",
      entityId: payment.giftCardId,
      metadata: { checkoutId, refundId: refund.id, amountCents: refund.amountCents },
    });
  }
  if (closed) await tx.update(checkout).set({ status: "void" }).where(eq(checkout.id, checkoutId));
  return closed;
}
