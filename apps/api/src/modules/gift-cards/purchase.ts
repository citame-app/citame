import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { GiftCardPurchaseInput, GiftOfferOrder } from "@sob/contracts";
import { clientProfile, type Database, giftCard, giftOffer } from "@sob/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { recordAudit } from "../../audit";
import type { Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import { createCheckoutInTransaction, getCheckoutInTransaction } from "../commerce/service";
import { giftCode, giftCodeHash } from "./code";
import {
  authorizeGiftAccess,
  giftView,
  normalizedGiftServices,
  reviewGiftServices,
} from "./service";

type GiftTerms = {
  amountCents: number;
  purchasePriceCents: number;
  label: string;
  expiresAt: string | null;
  eligibleServiceIds: string[];
};
type GiftRequest =
  | ({ kind: "direct"; buyerClientId: string | null; idempotencyKey: string } & GiftTerms)
  | ({ kind: "storefront"; paymentsEnabled: boolean } & GiftOfferOrder);

export function purchaseGift(
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
  return createGift(
    db,
    {
      kind: "direct",
      amountCents: input.amountCents,
      purchasePriceCents: input.purchasePriceCents ?? input.amountCents,
      label: input.label,
      buyerClientId:
        principal.role === "client" ? principal.clientId : (input.buyerClientId ?? null),
      expiresAt: input.expiresAt ?? null,
      eligibleServiceIds: normalizedGiftServices(input.eligibleServiceIds),
      idempotencyKey: input.idempotencyKey,
    },
    principal,
    secret,
  );
}

export function orderGiftOffer(
  db: Database,
  input: GiftOfferOrder,
  principal: Principal,
  secret: string,
  paymentsEnabled: boolean,
) {
  if (principal.role !== "client" || !principal.clientId)
    throw new DomainError("forbidden", "Use a customer account to order a public gift");
  return createGift(
    db,
    {
      kind: "storefront",
      ...input,
      offerId: input.offerId.toLowerCase(),
      paymentsEnabled,
    },
    principal,
    secret,
  );
}

function purchaseHash(request: GiftRequest) {
  const data =
    request.kind === "storefront"
      ? { offerId: request.offerId, offerVersion: request.version }
      : {
          amountCents: request.amountCents,
          label: request.label,
          buyerClientId: request.buyerClientId,
          expiresAt: request.expiresAt,
          ...(request.purchasePriceCents !== request.amountCents
            ? { purchasePriceCents: request.purchasePriceCents }
            : {}),
          ...(request.eligibleServiceIds.length
            ? { eligibleServiceIds: request.eligibleServiceIds }
            : {}),
        };
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

function createGift(db: Database, request: GiftRequest, principal: Principal, secret: string) {
  const { idempotencyKey } = request;
  const buyerClientId = request.kind === "storefront" ? principal.clientId : request.buyerClientId;
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`gift-purchase:${principal.userId}:${idempotencyKey}`}, 0))`,
    );
    const requestHash = purchaseHash(request);
    const [previous] = await tx
      .select()
      .from(giftCard)
      .where(
        and(eq(giftCard.createdBy, principal.userId), eq(giftCard.idempotencyKey, idempotencyKey)),
      );
    if (previous) {
      if (previous.requestHash !== requestHash)
        throw new DomainError("invalid_state", "Gift purchase key belongs to another request");
      const card = await giftView(tx, previous);
      return { card, checkout: await getCheckoutInTransaction(tx, card.checkoutId, principal) };
    }

    let offer: typeof giftOffer.$inferSelect | undefined;
    let terms: GiftTerms;
    if (request.kind === "storefront") {
      if (!request.paymentsEnabled)
        throw new DomainError("payment_unavailable", "Online gift purchases are unavailable");
      [offer] = await tx
        .select()
        .from(giftOffer)
        .where(eq(giftOffer.id, request.offerId))
        .for("share");
      if (!offer?.published || offer.version !== request.version)
        throw new DomainError("version_conflict", "Gift offer changed; review it before ordering");
      terms = {
        label: offer.name,
        amountCents: offer.amountCents,
        purchasePriceCents: offer.priceCents,
        eligibleServiceIds: offer.eligibleServiceIds,
        expiresAt: null,
      };
    } else {
      terms = request;
    }

    if (terms.expiresAt && new Date(terms.expiresAt).getTime() <= Date.now())
      throw new DomainError("validation_error", "New gift expiry must be in the future");
    if (buyerClientId) {
      const [buyer] = await tx
        .select({ id: clientProfile.id })
        .from(clientProfile)
        .where(and(eq(clientProfile.id, buyerClientId), isNull(clientProfile.deletedAt)));
      if (!buyer) throw new DomainError("validation_error", "Choose an active buyer");
    }
    const eligibleServices = await reviewGiftServices(tx, terms.eligibleServiceIds);
    const id = randomUUID();
    const nonce = randomBytes(16).toString("hex");
    const code = giftCode(secret, id, nonce);
    const [row] = await tx
      .insert(giftCard)
      .values({
        id,
        label: terms.label,
        buyerClientId,
        offerId: offer?.id,
        offerValidityDays: offer?.validityDays,
        offerTheme: offer?.theme,
        amountCents: terms.amountCents,
        eligibleServices: sql`${JSON.stringify(eligibleServices)}::text::jsonb`,
        codeNonce: nonce,
        codeHash: giftCodeHash(code),
        codeLast4: code.slice(-4),
        expiresAt: terms.expiresAt ? new Date(terms.expiresAt) : null,
        createdBy: principal.userId,
        idempotencyKey,
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
      { giftPurchase: { priceCents: terms.purchasePriceCents } },
    );
    await recordAudit(tx, {
      actorUserId: principal.userId,
      action: "gift_card.purchase_created",
      entity: "gift_card",
      entityId: id,
      metadata: {
        checkoutId: sale.id,
        amountCents: row.amountCents,
        purchasePriceCents: terms.purchasePriceCents,
        eligibleServiceIds: terms.eligibleServiceIds,
        ...(offer ? { offerId: offer.id, offerVersion: offer.version } : {}),
      },
    });
    return { card: await giftView(tx, row), checkout: sale };
  });
}
