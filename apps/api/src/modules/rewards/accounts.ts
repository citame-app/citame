import { createHash } from "node:crypto";
import { type LoyaltyPolicy, permissionsFor } from "@sob/contracts";
import { type Database, loyaltyLot, loyaltyMovement, loyaltyProgram } from "@sob/db";
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { requirePermission, requireRole } from "../../auth/policy";
import { ownsClient, type Principal } from "../../auth/principal";
import { clientIdentityIds, clientRoot, lockClientRoot } from "../../client-identity";
import { DomainError } from "../../errors";
import type { Tx } from "../../tx";

export type RewardConnection = Database | Tx;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  return value;
}
export const rewardHash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
export const DEFAULT_LOYALTY: LoyaltyPolicy = {
  enabled: false,
  earnEveryCents: 100,
  pointsPerStep: 1,
  redeemValueCents: 1,
  maximumDiscountBasisPoints: 2000,
  expiryDays: 365,
  version: 1,
};
export async function getLoyaltyPolicy(db: RewardConnection): Promise<LoyaltyPolicy> {
  const [row] = await db.select().from(loyaltyProgram).where(eq(loyaltyProgram.id, 1));
  return row ? { ...row.terms, version: row.version } : { ...DEFAULT_LOYALTY };
}
export async function setLoyaltyPolicy(db: Database, input: LoyaltyPolicy, principal: Principal) {
  requireRole(principal, "owner");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('loyalty-policy', 0))`);
    const current = await getLoyaltyPolicy(tx);
    if (current.version !== input.version)
      throw new DomainError(
        "version_conflict",
        "Loyalty policy changed; review the current version",
      );
    const { version: _, ...terms } = input;
    await tx
      .insert(loyaltyProgram)
      .values({ terms, version: current.version + 1 })
      .onConflictDoUpdate({
        target: loyaltyProgram.id,
        set: { terms, version: current.version + 1, updatedAt: new Date() },
      });
    await recordAudit(tx, {
      actorUserId: principal.userId,
      action: "rewards.policy_updated",
      entity: "loyalty_program",
      entityId: "1",
      metadata: { version: current.version + 1, enabled: input.enabled },
    });
    return { ...terms, version: current.version + 1 };
  });
}
export async function lockRewardClient(tx: Tx, clientId: string, includeArchived = false) {
  return lockClientRoot(tx, clientId, includeArchived);
}
export function authorizeRewardClient(principal: Principal, clientId: string) {
  if (principal.role === "client") {
    if (!ownsClient(principal, clientId)) throw new DomainError("not_found", "Customer not found");
  } else {
    requirePermission(principal, "clients");
    requirePermission(principal, "commerce");
  }
}
export async function rewardBalance(db: RewardConnection, clientId: string, now = new Date()) {
  const [totals] = await db.execute<{
    available: string;
    debt: string;
    expiring: string;
    held: string;
  }>(sql`with identities as materialized (select client_identity_ids(${clientId}::uuid) as id) select
  (select coalesce(sum(l.remaining_points),0) from loyalty_lot l where l.client_id in(select id from identities) and (l.expires_at is null or l.expires_at>${now}))::text as available,
  (select coalesce(sum(l.revoked_spent_points),0) from loyalty_lot l where l.client_id in(select id from identities))::text as debt,
  (select coalesce(sum(l.remaining_points),0) from loyalty_lot l where l.client_id in(select id from identities) and l.expires_at>${now} and l.expires_at<=${new Date(now.getTime() + 30 * 86400000)})::text as expiring,
  (select coalesce(sum(r.points_used),0) from checkout_reward r where r.client_id in(select id from identities) and r.kind='points' and r.state='held')::text as held`);
  const balancePoints = Number(totals?.available ?? 0) - Number(totals?.debt ?? 0);
  if (!Number.isSafeInteger(balancePoints))
    throw new DomainError("invalid_state", "Loyalty balance requires review");
  return {
    balancePoints,
    availablePoints: Math.max(0, balancePoints),
    debtPoints: Number(totals?.debt ?? 0),
    reservedPoints: Number(totals?.held ?? 0),
    expiringPoints: Number(totals?.expiring ?? 0),
  };
}
export async function loyaltyStatement(
  db: Database,
  clientId: string,
  principal: Principal,
  page = 1,
) {
  authorizeRewardClient(principal, clientId);
  return db.transaction(
    async (tx) => {
      await clientRoot(tx, clientId);
      const identities = await clientIdentityIds(tx, clientId);
      const restricted =
        principal.role === "staff" &&
        !permissionsFor(principal.role, principal.accessPreset).allSales;
      const movementScope = and(
        inArray(loyaltyMovement.clientId, identities),
        restricted
          ? sql`exists (select 1 from checkout c where c.id=${loyaltyMovement.checkoutId} and (c.staff_id=${principal.staffId} or (c.staff_id is null and c.created_by=${principal.userId})))`
          : undefined,
      );
      const movements = await tx
        .select()
        .from(loyaltyMovement)
        .where(movementScope)
        .orderBy(desc(loyaltyMovement.createdAt), desc(loyaltyMovement.id))
        .limit(20)
        .offset((page - 1) * 20);
      const [total] = await tx
        .select({ value: count() })
        .from(loyaltyMovement)
        .where(movementScope);
      return {
        policy: await getLoyaltyPolicy(tx),
        ...(await rewardBalance(tx, clientId)),
        movements: movements.map((m) => ({
          id: m.id,
          kind: m.kind,
          points: m.points,
          checkoutId: m.checkoutId,
          createdAt: m.createdAt.toISOString(),
        })),
        pagination: { page, pageSize: 20, total: total?.value ?? 0 },
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
export async function availableRewardLots(tx: Tx, clientId: string, now = new Date()) {
  return tx
    .select()
    .from(loyaltyLot)
    .where(
      and(
        sql`${loyaltyLot.clientId} in(select client_identity_ids(${clientId}::uuid))`,
        sql`${loyaltyLot.remainingPoints}>0`,
        sql`(${loyaltyLot.expiresAt} is null or ${loyaltyLot.expiresAt}>${now})`,
      ),
    )
    .orderBy(asc(loyaltyLot.expiresAt), asc(loyaltyLot.createdAt), asc(loyaltyLot.id))
    .for("update");
}
export async function adjustRewards(
  db: Database,
  clientId: string,
  input: { points: number; reason: string; idempotencyKey: string },
  principal: Principal,
) {
  requirePermission(principal, "refunds");
  authorizeRewardClient(principal, clientId);
  return db.transaction(async (tx) => {
    const eventKey = `loyalty-adjustment:${principal.userId}:${input.idempotencyKey}`;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${eventKey},0))`);
    const requestHash = rewardHash({ clientId, points: input.points, reason: input.reason });
    const [previous] = await tx
      .select()
      .from(loyaltyMovement)
      .where(eq(loyaltyMovement.eventKey, eventKey));
    if (previous) {
      if (previous.requestHash !== requestHash)
        throw new DomainError("invalid_state", "Adjustment key belongs to a different request");
      return { id: previous.id, points: previous.points };
    }
    const root = await lockRewardClient(tx, clientId);
    if (root.id !== clientId)
      throw new DomainError("client_merged", "Review the surviving client before adjusting points");
    const policy = await getLoyaltyPolicy(tx);
    if (!policy.enabled) throw new DomainError("invalid_state", "Loyalty is disabled");
    const now = new Date();
    let lotId: string | null = null;
    if (input.points > 0) {
      const [lot] = await tx
        .insert(loyaltyLot)
        .values({
          clientId,
          grantedPoints: input.points,
          remainingPoints: input.points,
          policyVersion: policy.version,
          expiresAt: policy.expiryDays
            ? new Date(now.getTime() + policy.expiryDays * 86400000)
            : null,
        })
        .returning();
      if (!lot) throw new Error("Loyalty adjustment insert failed");
      lotId = lot.id;
    } else {
      const balance = await rewardBalance(tx, clientId, now);
      if (balance.availablePoints < -input.points)
        throw new DomainError("invalid_state", "Adjustment exceeds available points");
      let needed = -input.points;
      for (const lot of await availableRewardLots(tx, clientId, now)) {
        const n = Math.min(needed, lot.remainingPoints);
        await tx
          .update(loyaltyLot)
          .set({
            remainingPoints: lot.remainingPoints - n,
            spentPoints: lot.spentPoints + n,
          })
          .where(eq(loyaltyLot.id, lot.id));
        needed -= n;
        if (!needed) break;
      }
    }
    const [movement] = await tx
      .insert(loyaltyMovement)
      .values({
        clientId,
        lotId,
        kind: "adjustment",
        points: input.points,
        reason: input.reason,
        eventKey,
        requestHash,
        createdBy: principal.userId,
      })
      .returning();
    if (!movement) throw new Error("Loyalty movement insert failed");
    await recordAudit(tx, {
      actorUserId: principal.userId,
      action: "rewards.adjusted",
      entity: "client_profile",
      entityId: clientId,
      metadata: { points: input.points, reason: input.reason, movementId: movement.id },
    });
    return { id: movement.id, points: movement.points };
  });
}
