import type { GiftOffer, GiftOfferUpdate, PublicGiftOffer } from "@sob/contracts";
import { type Database, giftOffer } from "@sob/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { requirePermission } from "../../auth/policy";
import { loadPrincipal, type Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import { giftEligibleCatalog, normalizedGiftServices, reviewGiftServices } from "./service";

type OfferRow = typeof giftOffer.$inferSelect;
function offerView(row: OfferRow): GiftOffer {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    theme: row.theme,
    amountCents: row.amountCents,
    priceCents: row.priceCents,
    validityDays: row.validityDays,
    eligibleServiceIds: row.eligibleServiceIds,
    published: row.published,
    version: row.version,
  };
}

export async function giftOffers(db: Database, principal: Principal) {
  requirePermission(principal, "editCatalog");
  const rows = await db.select().from(giftOffer).orderBy(asc(giftOffer.name), asc(giftOffer.id));
  return { offers: rows.map(offerView) };
}

export async function publicGiftOffers(db: Database, paymentsEnabled: boolean) {
  if (!paymentsEnabled) return { offers: [] };
  return db.transaction(
    async (tx) => {
      const rows = await tx
        .select()
        .from(giftOffer)
        .where(eq(giftOffer.published, true))
        .orderBy(asc(giftOffer.name), asc(giftOffer.id));
      if (!rows.length) return { offers: [] };
      const catalog = new Map(
        (await giftEligibleCatalog(tx)).services.map((service) => [service.id, service]),
      );
      const offers: PublicGiftOffer[] = [];
      for (const row of rows) {
        const { published: _, eligibleServiceIds, ...terms } = offerView(row);
        const eligibleServices = eligibleServiceIds.flatMap((id) => catalog.get(id) ?? []);
        if (eligibleServices.length === eligibleServiceIds.length)
          offers.push({ ...terms, eligibleServices });
      }
      return { offers };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

export async function saveGiftOffer(
  db: Database,
  id: string,
  input: GiftOfferUpdate,
  principal: Principal,
) {
  requirePermission(principal, "editCatalog");
  const { version, ...rawTerms } = input;
  const terms = {
    ...rawTerms,
    eligibleServiceIds: normalizedGiftServices(rawTerms.eligibleServiceIds),
  };
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`gift-offer:${id}`}, 0))`);
    const actor = await loadPrincipal(tx, principal.userId);
    if (!actor) throw new DomainError("forbidden", "Account is unavailable");
    requirePermission(actor, "editCatalog");
    const [current] = await tx.select().from(giftOffer).where(eq(giftOffer.id, id)).for("update");
    if (current && (current.version === version || current.version === version + 1)) {
      const same = Object.entries(terms).every(
        ([key, value]) => JSON.stringify(current[key as keyof OfferRow]) === JSON.stringify(value),
      );
      if (same) return offerView(current);
    }
    if ((current?.version ?? 0) !== version)
      throw new DomainError("version_conflict", "Offer changed; reload it before editing");
    if (terms.published) await reviewGiftServices(tx, terms.eligibleServiceIds);
    const [saved] = current
      ? await tx
          .update(giftOffer)
          .set({ ...terms, version: version + 1 })
          .where(and(eq(giftOffer.id, id), eq(giftOffer.version, version)))
          .returning()
      : await tx
          .insert(giftOffer)
          .values({ id, ...terms })
          .returning();
    if (!saved) throw new DomainError("version_conflict", "Could not save the reviewed offer");
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: "gift_card.offer_saved",
      entity: "gift_offer",
      entityId: id,
      metadata: { version: saved.version, published: saved.published },
    });
    return offerView(saved);
  });
}
