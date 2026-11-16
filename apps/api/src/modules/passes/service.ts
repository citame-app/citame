import {
  type BenefitPurchaseInput,
  MEMBERSHIP_RECURRING_CONSENT_VERSION,
  type PassContract,
  type PassPeriod,
  permissionsFor,
} from "@sob/contracts";
import {
  benefitPlan,
  checkout,
  checkoutLine,
  clientProfile,
  type Database,
  passContract,
  passPeriod,
  passUnit,
} from "@sob/db";
import { and, asc, count, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { requirePermission } from "../../auth/policy";
import type { Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import type { Tx } from "../../tx";
import { getCheckoutInTransaction } from "../commerce/service";
import { getSalonSettings } from "../settings/service";
import { intentHash, validateServices } from "./catalog";
import { revokeCardMandate } from "./mandates";
import { currentMembershipIndex, membershipTermsHash } from "./terms";
export type Connection = Database | Tx;
export function authorizePass(p: Principal) {
  if (p.role !== "client") requirePermission(p, "commerce");
}
function scope(p: Principal) {
  authorizePass(p);
  return permissionsFor(p.role, p.accessPreset).allSales
    ? undefined
    : or(
        eq(passContract.createdBy, p.userId),
        p.clientId ? eq(passContract.clientId, p.clientId) : undefined,
      );
}
export async function visiblePass(db: Connection, id: string, p: Principal, lock = false) {
  const query = db
    .select()
    .from(passContract)
    .where(and(eq(passContract.id, id), scope(p)));
  const [row] = await (lock ? query.for("update") : query);
  if (!row) throw new DomainError("not_found", "Pass not found");
  return row;
}
export async function periodView(
  db: Connection,
  row: typeof passPeriod.$inferSelect,
): Promise<PassPeriod> {
  const [line] = await db
    .select({ checkoutId: checkoutLine.checkoutId })
    .from(checkoutLine)
    .where(eq(checkoutLine.passPeriodId, row.id));
  if (!line) throw new Error("Pass period has no purchase invoice");
  const units = await db.select().from(passUnit).where(eq(passUnit.periodId, row.id));
  const status =
    row.status === "active"
      ? row.startsAt && row.startsAt.getTime() > Date.now()
        ? "upcoming"
        : row.endsAt && row.endsAt.getTime() <= Date.now()
          ? "expired"
          : "active"
      : (row.status as "pending" | "void");
  return {
    id: row.id,
    contractId: row.contractId,
    index: row.index,
    checkoutId: line.checkoutId,
    status,
    priceCents: row.priceCents,
    startsAt: row.startsAt?.toISOString() ?? null,
    endsAt: row.endsAt?.toISOString() ?? null,
    availableUses: units.filter((u) => u.status === "available").length,
    usedUses: units.filter((u) => u.status === "used").length,
    heldUses: units.filter((u) => u.status === "held").length,
    returnedUses: units.filter((u) => u.status === "retired").length,
    remainingAllocationCents: units
      .filter((u) => u.status === "available" || u.status === "held")
      .reduce((sum, u) => sum + u.allocatedCents, 0),
    version: row.version,
  };
}
export async function passView(
  db: Connection,
  row: typeof passContract.$inferSelect,
  periodPage = 1,
  periodLimit = 20,
): Promise<PassContract> {
  const periods = await db
    .select()
    .from(passPeriod)
    .where(eq(passPeriod.contractId, row.id))
    .orderBy(desc(passPeriod.index))
    .limit(periodLimit)
    .offset((periodPage - 1) * periodLimit);
  const [buyer] = await db
    .select({ name: clientProfile.name })
    .from(clientProfile)
    .where(eq(clientProfile.id, row.clientId));
  return {
    id: row.id,
    planId: row.planId,
    clientId: row.clientId,
    clientName: buyer?.name,
    kind: row.kind as "package" | "membership",
    name: row.name,
    priceCents: row.priceCents,
    currency: "EUR",
    includedUses: row.includedUses,
    discountBasisPoints: row.discountBasisPoints,
    serviceIds: row.serviceIds,
    periodMonths: row.periodMonths,
    validityDays: row.validityDays,
    timezone: row.timezone,
    status: row.status as PassContract["status"],
    renewalMode: row.renewalMode as "manual" | "automatic",
    autoPayReady: row.autoPayReady,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    version: row.version,
    periods: await Promise.all(periods.map((r) => periodView(db, r))),
    createdAt: row.createdAt.toISOString(),
  };
}
export async function getPass(db: Database, id: string, p: Principal) {
  return db.transaction(async (tx) => passView(tx, await visiblePass(tx, id, p)), {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
}
export async function listPasses(
  db: Database,
  p: Principal,
  page = 1,
  search = "",
  clientId?: string,
) {
  const where = and(
    scope(p),
    clientId ? eq(passContract.clientId, clientId) : undefined,
    search ? ilike(passContract.name, `%${search.replace(/[\\%_]/g, "\\$&")}%`) : undefined,
  );
  return db.transaction(
    async (tx) => {
      const [total] = await tx.select({ n: count() }).from(passContract).where(where);
      const rows = await tx
        .select()
        .from(passContract)
        .where(where)
        .orderBy(desc(passContract.createdAt), asc(passContract.id))
        .limit(20)
        .offset((page - 1) * 20);
      return {
        passes: await Promise.all(rows.map((r) => passView(tx, r, 1, 1))),
        pagination: { page, pageSize: 20, total: total?.n ?? 0 },
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
/** Private invoice factory: caller has authenticated the buyer and frozen the plan terms. */
export async function createPassPeriodInvoice(
  tx: Tx,
  contract: typeof passContract.$inferSelect,
  index: number,
  actorUserId: string | null,
) {
  const [period] = await tx
    .insert(passPeriod)
    .values({ contractId: contract.id, index, priceCents: contract.priceCents })
    .returning();
  if (!period) throw new Error("Period insert failed");
  const taxCents = Math.round(
    (contract.priceCents * contract.taxBasisPoints) / (10000 + contract.taxBasisPoints),
  );
  const [sale] = await tx
    .insert(checkout)
    .values({
      clientId: contract.clientId,
      subtotalCents: contract.priceCents,
      totalCents: contract.priceCents,
      taxCents,
      createdBy: actorUserId,
      idempotencyKey: `pass-${period.id}`,
      requestHash: intentHash({ periodId: period.id, priceCents: contract.priceCents }),
    })
    .returning();
  if (!sale) throw new Error("Pass checkout insert failed");
  await tx.insert(checkoutLine).values({
    checkoutId: sale.id,
    kind: contract.kind === "package" ? "package_purchase" : "membership_period",
    passPeriodId: period.id,
    description: contract.name,
    quantity: 1,
    unitAmountCents: contract.priceCents,
    taxBasisPoints: contract.taxBasisPoints,
    taxCents,
  });
  return period;
}
async function purchaseView(
  tx: Tx,
  contract: typeof passContract.$inferSelect,
  period: typeof passPeriod.$inferSelect,
  p: Principal,
) {
  const view = await periodView(tx, period);
  return {
    pass: await passView(tx, contract),
    period: view,
    checkout: await getCheckoutInTransaction(tx, view.checkoutId, p),
  };
}
export async function purchasePass(
  db: Database,
  input: BenefitPurchaseInput,
  p: Principal,
  automaticPaymentsAvailable = false,
) {
  authorizePass(p);
  const clientId = p.role === "client" ? p.clientId : input.clientId;
  if (!clientId || (p.role === "client" && input.clientId && input.clientId !== p.clientId))
    throw new DomainError("forbidden", "A pass requires its authenticated buyer");
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`pass:${p.userId}:${input.idempotencyKey}`},0))`,
    );
    const { idempotencyKey, ...body } = input;
    const requestHash = intentHash({ ...body, clientId });
    const [old] = await tx
      .select()
      .from(passContract)
      .where(
        and(eq(passContract.createdBy, p.userId), eq(passContract.idempotencyKey, idempotencyKey)),
      );
    if (old) {
      if (old.requestHash !== requestHash)
        throw new DomainError("invalid_state", "Pass key belongs to another purchase");
      const [period] = await tx
        .select()
        .from(passPeriod)
        .where(and(eq(passPeriod.contractId, old.id), eq(passPeriod.index, 0)));
      if (!period) throw new Error("Missing initial period");
      return purchaseView(tx, old, period, p);
    }
    const [plan] = await tx
      .select()
      .from(benefitPlan)
      .where(and(eq(benefitPlan.id, input.planId), eq(benefitPlan.active, true)))
      .for("share");
    if (!plan) throw new DomainError("not_found", "Active plan not found");
    if (input.planVersion && input.planVersion !== plan.version)
      throw new DomainError("version_conflict", "Plan terms changed; review before purchasing");
    if (input.renewalMode === "automatic") {
      if (!automaticPaymentsAvailable)
        throw new DomainError(
          "payment_unavailable",
          "Automatic recurring payments are not configured",
        );
      if (p.role !== "client")
        throw new DomainError(
          "forbidden",
          "Only the client can authorize their recurring payments",
        );
      if (
        plan.kind !== "membership" ||
        !input.planVersion ||
        !input.acceptRecurring ||
        input.consentVersion !== MEMBERSHIP_RECURRING_CONSENT_VERSION
      )
        throw new DomainError(
          "validation_error",
          "Review and accept the current membership payment terms",
        );
    }
    const [buyer] = await tx
      .select({ id: clientProfile.id })
      .from(clientProfile)
      .where(and(eq(clientProfile.id, clientId), isNull(clientProfile.deletedAt)));
    if (!buyer) throw new DomainError("not_found", "Buyer not found");
    await validateServices(tx, plan.serviceIds);
    const settings = await getSalonSettings(tx);
    const [contract] = await tx
      .insert(passContract)
      .values({
        planId: plan.id,
        clientId,
        kind: plan.kind,
        name: plan.name,
        priceCents: plan.priceCents,
        taxBasisPoints: plan.taxBasisPoints,
        includedUses: plan.includedUses,
        discountBasisPoints: plan.discountBasisPoints,
        serviceIds: plan.serviceIds,
        validityDays: plan.validityDays,
        periodMonths: plan.periodMonths,
        timezone: settings.timezone,
        renewalMode: input.renewalMode,
        consent:
          input.renewalMode === "automatic"
            ? {
                version: MEMBERSHIP_RECURRING_CONSENT_VERSION,
                planVersion: plan.version,
                actorUserId: p.userId,
                acceptedAt: new Date().toISOString(),
                termsHash: membershipTermsHash(plan),
              }
            : null,
        createdBy: p.userId,
        idempotencyKey,
        requestHash,
      })
      .returning();
    if (!contract) throw new Error("Pass insert failed");
    const period = await createPassPeriodInvoice(tx, contract, 0, p.userId);
    await recordAudit(tx, {
      actorUserId: p.userId,
      action: "pass.purchase_created",
      entity: "pass_contract",
      entityId: contract.id,
      metadata: { periodId: period.id, priceCents: plan.priceCents },
    });
    return purchaseView(tx, contract, period, p);
  });
}
export async function renewPass(db: Database, id: string, p: Principal) {
  authorizePass(p);
  return db.transaction(async (tx) => {
    const contract = await visiblePass(tx, id, p, true);
    if (
      contract.kind !== "membership" ||
      contract.status !== "active" ||
      contract.cancelAtPeriodEnd
    )
      throw new DomainError("invalid_state", "Membership cannot be renewed");
    const [last] = await tx
      .select()
      .from(passPeriod)
      .where(eq(passPeriod.contractId, id))
      .orderBy(desc(passPeriod.index))
      .limit(1)
      .for("update");
    if (!last) throw new Error("Missing membership period");
    if (last.status === "pending" || (last.startsAt && last.startsAt.getTime() > Date.now()))
      return purchaseView(tx, contract, last, p);
    const nextIndex =
      contract.anchorAt && contract.periodMonths
        ? currentMembershipIndex(
            contract.anchorAt,
            contract.timezone,
            contract.periodMonths,
            last.index + 1,
            new Date(),
          )
        : last.index + 1;
    const next = await createPassPeriodInvoice(tx, contract, nextIndex, p.userId);
    await recordAudit(tx, {
      actorUserId: p.userId,
      action: "pass.renewal_created",
      entity: "pass_contract",
      entityId: id,
      metadata: { periodId: next.id, index: next.index },
    });
    return purchaseView(tx, contract, next, p);
  });
}
export async function cancelPass(
  db: Database,
  id: string,
  input: { version: number; reason: string },
  p: Principal,
) {
  authorizePass(p);
  return db.transaction(async (tx) => {
    const contract = await visiblePass(tx, id, p, true);
    // Stopping future charges is monotonic; background settlement must not defeat this intent.
    if (input.version > contract.version)
      throw new DomainError("version_conflict", "Unknown membership revision");
    if (contract.kind !== "membership")
      throw new DomainError("invalid_state", "Only memberships have renewal cancellation");
    if (contract.cancelAtPeriodEnd) return passView(tx, contract);
    if (!["active", "pending"].includes(contract.status))
      throw new DomainError("invalid_state", "Only active memberships can be cancelled");
    await revokeCardMandate(tx, id);
    const [saved] = await tx
      .update(passContract)
      .set({ cancelAtPeriodEnd: true, autoPayReady: false, version: contract.version + 1 })
      .where(eq(passContract.id, id))
      .returning();
    if (!saved) throw new Error("Pass cancellation failed");
    await recordAudit(tx, {
      actorUserId: p.userId,
      action: "pass.cancelled",
      entity: "pass_contract",
      entityId: id,
      metadata: { reason: input.reason },
    });
    return passView(tx, saved);
  });
}
