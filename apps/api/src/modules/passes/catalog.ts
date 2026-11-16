import { createHash } from "node:crypto";
import {
  benefitPlanTermsSchema,
  type CreateBenefitPlanInput,
  type UpdateBenefitPlanInput,
} from "@sob/contracts";
import { benefitPlan, type Database, service } from "@sob/db";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { requirePermission } from "../../auth/policy";
import type { Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import type { Tx } from "../../tx";
export const intentHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function planView(row: typeof benefitPlan.$inferSelect) {
  return {
    ...row,
    currency: "EUR" as const,
    kind: row.kind as "package" | "membership",
    createdBy: undefined,
    idempotencyKey: undefined,
    requestHash: undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
export async function validateServices(tx: Tx, ids: string[]) {
  const rows = await tx
    .select({ id: service.id })
    .from(service)
    .where(
      and(
        inArray(service.id, ids),
        eq(service.active, true),
        eq(service.currency, "EUR"),
        isNull(service.deletedAt),
      ),
    )
    .for("share");
  if (rows.length !== ids.length)
    throw new DomainError("not_found", "Plans require active services in EUR");
}
export async function listPlans(db: Database, principal?: Principal) {
  if (principal) requirePermission(principal, "editCatalog");
  return {
    plans: (
      await db
        .select()
        .from(benefitPlan)
        .where(principal ? undefined : eq(benefitPlan.active, true))
        .orderBy(asc(benefitPlan.name), asc(benefitPlan.id))
    ).map(planView),
  };
}
export async function createPlan(db: Database, input: CreateBenefitPlanInput, p: Principal) {
  requirePermission(p, "editCatalog");
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`plan:${p.userId}:${input.idempotencyKey}`},0))`,
    );
    const { idempotencyKey, ...terms } = input;
    const hash = intentHash(terms);
    const [old] = await tx
      .select()
      .from(benefitPlan)
      .where(
        and(eq(benefitPlan.createdBy, p.userId), eq(benefitPlan.idempotencyKey, idempotencyKey)),
      );
    if (old) {
      if (old.requestHash !== hash)
        throw new DomainError("invalid_state", "Plan key belongs to another request");
      return planView(old);
    }
    await validateServices(tx, input.serviceIds);
    const [row] = await tx
      .insert(benefitPlan)
      .values({ ...input, createdBy: p.userId, requestHash: hash })
      .returning();
    if (!row) throw new Error("Plan insert failed");
    await recordAudit(tx, {
      actorUserId: p.userId,
      action: "benefit_plan.created",
      entity: "benefit_plan",
      entityId: row.id,
    });
    return planView(row);
  });
}
export async function updatePlan(
  db: Database,
  id: string,
  input: UpdateBenefitPlanInput,
  p: Principal,
) {
  requirePermission(p, "editCatalog");
  return db.transaction(async (tx) => {
    const [old] = await tx.select().from(benefitPlan).where(eq(benefitPlan.id, id)).for("update");
    if (!old) throw new DomainError("not_found", "Plan not found");
    if (old.version !== input.version)
      throw new DomainError("version_conflict", "Plan changed; reload before editing");
    const { version, ...change } = input;
    const merged = { ...old, ...change };
    const parsed = benefitPlanTermsSchema.safeParse(
      Object.fromEntries(
        [
          "name",
          "description",
          "kind",
          "priceCents",
          "taxBasisPoints",
          "includedUses",
          "discountBasisPoints",
          "serviceIds",
          "validityDays",
          "periodMonths",
          "active",
        ].map((key) => [key, merged[key as keyof typeof merged]]),
      ),
    );
    if (!parsed.success) throw new DomainError("validation_error", "Invalid plan terms");
    if (change.serviceIds) await validateServices(tx, change.serviceIds);
    const [saved] = await tx
      .update(benefitPlan)
      .set({ ...parsed.data, version: version + 1 })
      .where(eq(benefitPlan.id, id))
      .returning();
    if (!saved) throw new Error("Plan update failed");
    await recordAudit(tx, {
      actorUserId: p.userId,
      action: "benefit_plan.updated",
      entity: "benefit_plan",
      entityId: id,
      metadata: { version: version + 1 },
    });
    return planView(saved);
  });
}
