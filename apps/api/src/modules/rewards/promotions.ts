import type { PromotionInput } from "@sob/contracts";
import { checkoutReward, type Database, pgErrorCode, promotion } from "@sob/db";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { requirePermission } from "../../auth/policy";
import type { Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import { getServicesByIds } from "../services/service";
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
      const usage = rows.length
        ? await tx
            .select({ promotionId: checkoutReward.promotionId, count: count() })
            .from(checkoutReward)
            .where(
              and(
                inArray(
                  checkoutReward.promotionId,
                  rows.map((r) => r.id),
                ),
                inArray(checkoutReward.state, ["held", "applied"]),
              ),
            )
            .groupBy(checkoutReward.promotionId)
        : [];
      return {
        promotions: rows.map((r) =>
          promotionView(r, usage.find((u) => u.promotionId === r.id)?.count ?? 0),
        ),
        pagination: { page, pageSize: 20, total: total?.value ?? 0 },
      };
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
  const { version, code, name, ...raw } = input;
  const terms = {
    ...raw,
    startsAt: raw.startsAt ? new Date(raw.startsAt).toISOString() : null,
    endsAt: raw.endsAt ? new Date(raw.endsAt).toISOString() : null,
  };
  try {
    return await db.transaction(async (tx) => {
      let row: typeof promotion.$inferSelect | undefined;
      if (id) {
        const [current] = await tx
          .select()
          .from(promotion)
          .where(eq(promotion.id, id))
          .for("update");
        if (!current) throw new DomainError("not_found", "Promotion not found");
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
        metadata: { version: row.version, active: row.terms.active },
      });
      return promotionView(row);
    });
  } catch (error) {
    if (pgErrorCode(error) === "23505")
      throw new DomainError("invalid_state", "Promotion code already exists");
    throw error;
  }
}
