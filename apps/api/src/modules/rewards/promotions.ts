import {
  needsFinalPrice,
  type PromotionInput,
  type PublicFlashOffer,
  promotionInputSchema,
} from "@sob/contracts";
import {
  checkoutReward,
  type Database,
  type PromotionTerms,
  pgErrorCode,
  promotion,
} from "@sob/db";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { requirePermission } from "../../auth/policy";
import type { Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import { parseOrThrow } from "../../http";
import { getServicesByIds, listServices } from "../services/service";
import { getSalonSettings } from "../settings/service";
import { rewardHash } from "./accounts";

const promotionView = (r: typeof promotion.$inferSelect, usedCount = 0) => ({
  ...r.terms,
  id: r.id,
  code: r.code,
  name: r.name,
  version: r.version,
  usedCount,
  createdAt: r.createdAt.toISOString(),
});
async function promotionUsage(db: Pick<Database, "select">, ids: string[]) {
  if (!ids.length) return new Map<string, number>();
  const rows = await db
    .select({ promotionId: checkoutReward.promotionId, count: count() })
    .from(checkoutReward)
    .where(
      and(
        inArray(checkoutReward.promotionId, ids),
        inArray(checkoutReward.state, ["held", "applied"]),
      ),
    )
    .groupBy(checkoutReward.promotionId);
  return new Map(rows.map(({ promotionId, count }) => [promotionId, count]));
}

export async function listPromotions(
  db: Database,
  principal: Principal,
  page: number,
  search = "",
) {
  requirePermission(principal, "editCatalog");
  const filter = search
    ? sql`position(${search.toLowerCase()} in lower(${promotion.code} || ' ' || ${promotion.name})) > 0`
    : undefined;
  return db.transaction(
    async (tx) => {
      const rows = await tx
        .select()
        .from(promotion)
        .where(filter)
        .orderBy(desc(promotion.createdAt), desc(promotion.id))
        .limit(20)
        .offset((page - 1) * 20);
      const [total] = await tx.select({ value: count() }).from(promotion).where(filter);
      const usage = await promotionUsage(
        tx,
        rows.map(({ id }) => id),
      );
      return {
        promotions: rows.map((row) => promotionView(row, usage.get(row.id) ?? 0)),
        pagination: { page, pageSize: 20, total: total?.value ?? 0 },
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
/** Only explicit, current service offers may be disclosed outside the admin desk. */
export async function publicFlashOffers(db: Database, now: Date) {
  return db.transaction(
    async (tx) => {
      // Older Bun SQL writes may store a JSON object as a JSON string.
      const storedTerms = sql`(case when jsonb_typeof(${promotion.terms}) = 'string'
        and pg_input_is_valid(${promotion.terms} #>> '{}', 'jsonb')
        then (${promotion.terms} #>> '{}')::jsonb else ${promotion.terms} end)`;
      const time = now.toISOString();
      const rows = (
        await tx
          .select()
          .from(promotion)
          .where(sql`${storedTerms} @> '{"active":true,"showOnline":true}'::jsonb`)
      ).filter(
        ({ terms }) =>
          terms.active &&
          terms.showOnline &&
          terms.startsAt &&
          terms.startsAt <= time &&
          terms.endsAt &&
          terms.endsAt > time &&
          !terms.timing &&
          terms.eligibleKinds.length === 1 &&
          terms.eligibleKinds[0] === "service",
      );
      if (!rows.length || !(await getSalonSettings(tx)).onlineBookingEnabled) return { offers: [] };
      const usage = await promotionUsage(
        tx,
        rows.filter(({ terms }) => terms.usageLimit !== null).map(({ id }) => id),
      );
      const visible = (await listServices(tx)).filter(
        (service) =>
          service.currency === "EUR" &&
          !needsFinalPrice(service.priceType) &&
          service.priceCents > 0,
      );
      const offers: PublicFlashOffer[] = [];
      rows.sort(
        (left, right) =>
          (left.terms.endsAt ?? "").localeCompare(right.terms.endsAt ?? "") ||
          left.id.localeCompare(right.id),
      );
      for (const { id, name, code, terms } of rows) {
        if (
          !terms.endsAt ||
          (terms.usageLimit !== null && (usage.get(id) ?? 0) >= terms.usageLimit)
        )
          continue;
        const services = visible.filter(
          (service) => !terms.serviceIds.length || terms.serviceIds.includes(service.id),
        );
        if (!services.length) continue;
        offers.push({
          id,
          name,
          code,
          kind: terms.kind,
          value: terms.value,
          minimumSpendCents: terms.minimumSpendCents,
          maximumDiscountCents: terms.maximumDiscountCents,
          perClientLimit: terms.perClientLimit,
          endsAt: terms.endsAt,
          allServices: terms.serviceIds.length === 0,
          services: terms.serviceIds.length ? services.map(({ id, name }) => ({ id, name })) : [],
        });
        if (offers.length === 12) break;
      }
      return { offers };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

export async function savePromotion(
  db: Database,
  id: string | null,
  input: PromotionInput,
  principal: Principal,
  allowIdenticalReplay = false,
) {
  requirePermission(principal, "editCatalog");
  const { version, code, name, showOnline, ...raw } = input;
  const normalized = {
    ...raw,
    startsAt: raw.startsAt ? new Date(raw.startsAt).toISOString() : null,
    endsAt: raw.endsAt ? new Date(raw.endsAt).toISOString() : null,
  };
  try {
    return await db.transaction(async (tx) => {
      let terms: PromotionTerms = normalized;
      let row: typeof promotion.$inferSelect | undefined;
      if (id) {
        const [current] = await tx
          .select()
          .from(promotion)
          .where(eq(promotion.id, id))
          .for("update");
        if (!current) throw new DomainError("not_found", "Promotion not found");
        if (showOnline ?? current.terms.showOnline) {
          parseOrThrow(promotionInputSchema, { ...input, showOnline: true });
          terms = { ...terms, showOnline: true };
        }
        if (
          allowIdenticalReplay &&
          version !== null &&
          (current.version === version || current.version === version + 1) &&
          current.code === code &&
          current.name === name &&
          rewardHash(current.terms) === rewardHash(terms)
        )
          return promotionView(current);
        if (current.version !== version)
          throw new DomainError("version_conflict", "Promotion changed; review the current terms");
        if (input.serviceIds.length) await getServicesByIds(tx, input.serviceIds);
        [row] = await tx
          .update(promotion)
          .set({ code, name, terms, version: current.version + 1 })
          .where(eq(promotion.id, id))
          .returning();
      } else {
        if (showOnline) terms = { ...terms, showOnline: true };
        if (version !== null)
          throw new DomainError("invalid_state", "A new promotion has no revision");
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`promotion:${code}`},0))`,
        );
        const [existing] = await tx.select().from(promotion).where(eq(promotion.code, code));
        if (existing) {
          if (
            rewardHash({ name: existing.name, terms: existing.terms }) !==
            rewardHash({ name, terms })
          )
            throw new DomainError(
              "invalid_state",
              "Promotion code already exists with different terms",
            );
          return promotionView(existing);
        }
        if (input.serviceIds.length) await getServicesByIds(tx, input.serviceIds);
        [row] = await tx
          .insert(promotion)
          .values({ code, name, terms, createdBy: principal.userId })
          .returning();
      }
      if (!row) throw new Error("Promotion write failed");
      await recordAudit(tx, {
        actorUserId: principal.userId,
        action: id ? "rewards.promotion_updated" : "rewards.promotion_created",
        entity: "promotion",
        entityId: row.id,
        metadata: {
          version: row.version,
          active: row.terms.active,
          showOnline: row.terms.showOnline ?? false,
        },
      });
      return promotionView(row);
    });
  } catch (error) {
    if (pgErrorCode(error) === "23505")
      throw new DomainError("invalid_state", "Promotion code already exists");
    throw error;
  }
}
