import { createHash } from "node:crypto";
import type { GiftOffer, GiftOfferDesk, GiftOfferUpdate, PublicGiftOffer } from "@sob/contracts";
import { type Database, giftOffer, service } from "@sob/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { requirePermission } from "../../auth/policy";
import { loadPrincipal, type Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import { listServices } from "../services/service";
import { normalizedGiftServices, reviewGiftServices } from "./service";

type OfferRow = typeof giftOffer.$inferSelect;

async function offerCatalogue(db: Pick<Database, "select">) {
  const services = await listServices(db, true);
  const revisions = new Map(
    (
      await db
        .select({
          id: service.id,
          version: service.catalogVersion,
          parentId: service.parentServiceId,
        })
        .from(service)
    ).map((row) => [row.id, row]),
  );
  return new Map(
    services
      .filter(({ currency }) => currency === "EUR")
      .map((row) => {
        const dependencies = row.catalog?.kind === "addon" ? row.catalog.allowedServiceIds : [];
        const keys = new Set([row.id, ...dependencies]);
        for (const id of keys) {
          const parent = revisions.get(id)?.parentId;
          if (parent) keys.add(parent);
        }
        return [
          row.id,
          {
            id: row.id,
            name: row.name,
            // Include variant parents and add-on bases, which can invalidate a treatment independently.
            versions: [...keys].sort().map((id) => [id, revisions.get(id)?.version ?? 0]),
          },
        ] as const;
      }),
  );
}

type OfferCatalogue = Awaited<ReturnType<typeof offerCatalogue>>;

function catalogueTerms(ids: string[], catalog: OfferCatalogue) {
  const entries = ids.flatMap((id) => catalog.get(id) ?? []);
  if (entries.length !== ids.length) return undefined;
  return {
    revision: entries.length
      ? createHash("sha256")
          .update(JSON.stringify(entries.map(({ versions }) => versions)))
          .digest("hex")
      : "",
    eligibleServices: entries.map(({ id, name }) => ({ id, name })),
  };
}

function reviewCatalogue(catalog: OfferCatalogue) {
  return createHash("sha256")
    .update(
      JSON.stringify([...catalog.values()].sort((left, right) => left.id.localeCompare(right.id))),
    )
    .digest("hex");
}

export async function verifyOfferCatalogue(db: Pick<Database, "select">, offer: OfferRow) {
  if (!offer.eligibleServiceIds.length) return;
  const terms = catalogueTerms(offer.eligibleServiceIds, await offerCatalogue(db));
  if (!terms || terms.revision !== offer.catalogueReview)
    throw new DomainError(
      "version_conflict",
      "Gift offer treatments changed; review the current offer",
    );
}

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

export async function giftOffers(
  db: Database,
  principal: Principal,
  generation: string,
): Promise<GiftOfferDesk> {
  requirePermission(principal, "editCatalog");
  return db.transaction(
    async (tx) => {
      const rows = await tx
        .select()
        .from(giftOffer)
        .orderBy(asc(giftOffer.name), asc(giftOffer.id));
      const catalog = await offerCatalogue(tx);
      return {
        generation,
        offers: rows.map(offerView),
        catalogueRevision: reviewCatalogue(catalog),
        catalogue: [...catalog.values()].map(({ id, name }) => ({ id, name })),
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
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
      const catalog = rows.some(({ eligibleServiceIds }) => eligibleServiceIds.length)
        ? await offerCatalogue(tx)
        : new Map();
      const offers: PublicGiftOffer[] = [];
      for (const row of rows) {
        const { published: _, eligibleServiceIds, ...terms } = offerView(row);
        const available = catalogueTerms(eligibleServiceIds, catalog);
        if (available && available.revision === row.catalogueReview)
          offers.push({ ...terms, eligibleServices: available.eligibleServices });
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
  const { version, generation: _, catalogueRevision, ...rawTerms } = input;
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
    const same =
      current &&
      Object.entries(terms).every(
        ([key, value]) => JSON.stringify(current[key as keyof OfferRow]) === JSON.stringify(value),
      );
    if (current?.version === version + 1 && same) return offerView(current);
    if ((current?.version ?? 0) !== version)
      throw new DomainError("version_conflict", "Offer changed; reload it before editing");

    let catalogueReview = "";
    if (terms.published && terms.eligibleServiceIds.length) {
      await reviewGiftServices(tx, terms.eligibleServiceIds);
      const currentCatalog = await offerCatalogue(tx);
      if (reviewCatalogue(currentCatalog) !== catalogueRevision)
        throw new DomainError(
          "version_conflict",
          "Gift offer treatments changed; review the latest catalogue",
        );
      const catalog = catalogueTerms(terms.eligibleServiceIds, currentCatalog);
      if (!catalog)
        throw new DomainError("validation_error", "Choose active services for the gift card");
      catalogueReview = catalog.revision;
    }
    if (current && same && current.catalogueReview === catalogueReview) return offerView(current);
    const [saved] = current
      ? await tx
          .update(giftOffer)
          .set({ ...terms, catalogueReview, version: version + 1 })
          .where(and(eq(giftOffer.id, id), eq(giftOffer.version, version)))
          .returning()
      : await tx
          .insert(giftOffer)
          .values({ id, ...terms, catalogueReview })
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
