import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { GiftCardPurchaseInput } from "@sob/contracts";
import { clientProfile, type Database, giftCard, service } from "@sob/db";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { recordAudit } from "../../audit";
import type { Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import { createCheckoutInTransaction, getCheckoutInTransaction } from "../commerce/service";
import { giftCode, giftCodeHash } from "./code";
import { authorizeGiftAccess, giftView } from "./service";
export async function purchaseGift(
  db: Database,
  input: GiftCardPurchaseInput,
  principal: Principal,
  secret: string,
) {
  authorizeGiftAccess(principal);
  if (
    principal.role === "client" &&
    ((input.buyerClientId && input.buyerClientId !== principal.clientId) ||
      input.expiresAt !== undefined ||
      input.purchasePriceCents !== undefined ||
      (input.eligibleServiceIds?.length ?? 0) > 0)
  )
    throw new DomainError("forbidden", "Clients cannot customize gift purchase terms");
  const eligibleServiceIds = [...new Set(input.eligibleServiceIds)].sort();
  const purchasePriceCents = input.purchasePriceCents ?? input.amountCents;
  const buyerClientId =
    principal.role === "client" ? principal.clientId : (input.buyerClientId ?? null);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`gift-purchase:${principal.userId}:${input.idempotencyKey}`}, 0))`,
    );
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          amountCents: input.amountCents,
          label: input.label,
          buyerClientId,
          expiresAt: input.expiresAt ?? null,
          ...(purchasePriceCents !== input.amountCents ? { purchasePriceCents } : {}),
          ...(eligibleServiceIds.length ? { eligibleServiceIds } : {}),
        }),
      )
      .digest("hex");
    const [previous] = await tx
      .select()
      .from(giftCard)
      .where(
        and(
          eq(giftCard.createdBy, principal.userId),
          eq(giftCard.idempotencyKey, input.idempotencyKey),
        ),
      );
    if (previous) {
      if (previous.requestHash !== requestHash)
        throw new DomainError("invalid_state", "Gift purchase key belongs to another request");
      const card = await giftView(tx, previous);
      return { card, checkout: await getCheckoutInTransaction(tx, card.checkoutId, principal) };
    }
    if (input.expiresAt && new Date(input.expiresAt).getTime() <= Date.now())
      throw new DomainError("validation_error", "New gift expiry must be in the future");
    if (buyerClientId) {
      const [buyer] = await tx
        .select({ id: clientProfile.id })
        .from(clientProfile)
        .where(and(eq(clientProfile.id, buyerClientId), isNull(clientProfile.deletedAt)));
      if (!buyer) throw new DomainError("validation_error", "Choose an active buyer");
    }
    const eligibleServices = eligibleServiceIds.length
      ? await tx
          .select({ id: service.id, name: service.name })
          .from(service)
          .where(
            and(
              inArray(service.id, eligibleServiceIds),
              eq(service.active, true),
              isNull(service.deletedAt),
            ),
          )
          .orderBy(asc(service.id))
          .for("share")
      : [];
    if (eligibleServices.length !== eligibleServiceIds.length)
      throw new DomainError("validation_error", "Choose active services for the gift card");
    const id = randomUUID();
    const nonce = randomBytes(16).toString("hex");
    const code = giftCode(secret, id, nonce);
    const [row] = await tx
      .insert(giftCard)
      .values({
        id,
        label: input.label,
        buyerClientId,
        amountCents: input.amountCents,
        eligibleServices: sql`${JSON.stringify(eligibleServices)}::text::jsonb`,
        codeNonce: nonce,
        codeHash: giftCodeHash(code),
        codeLast4: code.slice(-4),
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        createdBy: principal.userId,
        idempotencyKey: input.idempotencyKey,
        requestHash,
      })
      .returning();
    if (!row) throw new Error("Gift card insert failed");
    const sale = await createCheckoutInTransaction(
      tx,
      {
        ...(buyerClientId ? { clientId: buyerClientId } : {}),
        currency: "EUR",
        lines: [{ kind: "gift_card", giftCardId: id, quantity: 1, taxBasisPoints: 0 }],
        discountCents: 0,
        tipCents: 0,
        idempotencyKey: `gift-checkout-${id}`,
      },
      principal,
      { giftPurchase: { priceCents: purchasePriceCents } },
    );
    await recordAudit(tx, {
      actorUserId: principal.userId,
      action: "gift_card.purchase_created",
      entity: "gift_card",
      entityId: id,
      metadata: {
        checkoutId: sale.id,
        amountCents: row.amountCents,
        purchasePriceCents,
        eligibleServiceIds,
      },
    });
    return { card: await giftView(tx, row), checkout: sale };
  });
}
