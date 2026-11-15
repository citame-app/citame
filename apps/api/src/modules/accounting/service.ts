import { createHash } from "node:crypto";
import type { CommissionPayoutInput, CommissionPolicyInput, ReportQuery } from "@sob/contracts";
import { permissionsFor } from "@sob/contracts";
import {
  cashSession,
  checkout,
  checkoutLine,
  commissionAccrual,
  commissionPayout,
  commissionPolicy,
  type Database,
} from "@sob/db";
import { and, count, desc, eq, gte, lt, sql } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { requirePermission } from "../../auth/policy";
import type { Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import type { Tx } from "../../tx";
import { multiplyDivide } from "../commerce/money";
import { getSalonSettings } from "../settings/service";
import { requireStaff } from "../staff/admin";

type Connection = Database | Tx;
function ownStatement(principal: Principal, staffId: string) {
  requirePermission(principal, "commerce");
  if (
    !permissionsFor(principal.role, principal.accessPreset).financialReports &&
    principal.staffId !== staffId
  )
    throw new DomainError("forbidden", "Only your own commission statement is available");
}
export async function getPolicy(db: Database, staffId: string, principal: Principal) {
  ownStatement(principal, staffId);
  await requireStaff(db, staffId);
  const [row] = await db
    .select()
    .from(commissionPolicy)
    .where(eq(commissionPolicy.staffId, staffId));
  return row
    ? {
        staffId,
        serviceBasisPoints: row.serviceBasisPoints,
        productBasisPoints: row.productBasisPoints,
        version: row.version,
      }
    : { staffId, serviceBasisPoints: 0, productBasisPoints: 0, version: null };
}
export async function setPolicy(
  db: Database,
  staffId: string,
  input: CommissionPolicyInput,
  principal: Principal,
) {
  requirePermission(principal, "manageCommissions");
  await requireStaff(db, staffId);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`commission-policy:${staffId}`}, 0))`,
    );
    const [row] = await tx
      .select()
      .from(commissionPolicy)
      .where(eq(commissionPolicy.staffId, staffId))
      .for("update");
    if ((row?.version ?? null) !== input.version)
      throw new DomainError("version_conflict", "Commission policy changed; reload before editing");
    const values = {
      serviceBasisPoints: input.serviceBasisPoints,
      productBasisPoints: input.productBasisPoints,
      version: (row?.version ?? 0) + 1,
    };
    const [saved] = row
      ? await tx
          .update(commissionPolicy)
          .set(values)
          .where(eq(commissionPolicy.staffId, staffId))
          .returning()
      : await tx
          .insert(commissionPolicy)
          .values({ ...values, staffId })
          .returning();
    if (!saved) throw new Error("Commission policy update failed");
    await recordAudit(tx, {
      actorUserId: principal.userId,
      action: "commission.policy_updated",
      entity: "staff_profile",
      entityId: staffId,
      metadata: values,
    });
    return { staffId, ...values };
  });
}
/** Called once under the checkout row lock, in the settlement transaction. */
export async function accrueCommissions(tx: Tx, checkoutId: string) {
  const [sale] = await tx.select().from(checkout).where(eq(checkout.id, checkoutId));
  if (!sale?.staffId || sale.fulfilledAt) return;
  const [policy] = await tx
    .select()
    .from(commissionPolicy)
    .where(eq(commissionPolicy.staffId, sale.staffId))
    .for("share");
  if (!policy) return;
  const lines = await tx.select().from(checkoutLine).where(eq(checkoutLine.checkoutId, checkoutId));
  for (const line of lines) {
    if (line.kind !== "service" && line.kind !== "product") continue;
    const basisCents = line.quantity * line.unitAmountCents - line.discountCents - line.taxCents;
    const rateBasisPoints =
      line.kind === "service" ? policy.serviceBasisPoints : policy.productBasisPoints;
    const earnedCents = multiplyDivide(basisCents, rateBasisPoints, 10000);
    await tx.insert(commissionAccrual).values({
      staffId: sale.staffId,
      checkoutId,
      checkoutLineId: line.id,
      basisCents,
      rateBasisPoints,
      earnedCents,
    });
  }
}
// Net earned commission follows retained sale money. Excess captures never earn more commission.
const adjustedEarned = sql`coalesce(round(a.earned_cents * least(1::numeric, greatest(0::numeric,
 ((select coalesce(sum(p.amount_cents),0) from checkout_payment p where p.checkout_id = c.id and p.status in ('succeeded','reconciliation')) -
 (select coalesce(sum(r.amount_cents),0) from checkout_refund r join checkout_payment p on p.id = r.payment_id where p.checkout_id = c.id and r.status = 'succeeded'))::numeric / nullif(c.total_cents,0)))),0)::bigint`;
async function balances(db: Connection, staffId: string) {
  const [earned] = await db.execute<{ amount: string | number }>(
    sql`select coalesce(sum(${adjustedEarned}),0)::bigint as amount from commission_accrual a join checkout c on c.id = a.checkout_id where a.staff_id = ${staffId}`,
  );
  const [paid] = await db.execute<{ amount: string | number }>(
    sql`select coalesce(sum(amount_cents),0)::bigint as amount from commission_payout where staff_id = ${staffId}`,
  );
  const earnedCents = Number(earned?.amount ?? 0);
  const paidCents = Number(paid?.amount ?? 0);
  return { earnedCents, paidCents, outstandingCents: earnedCents - paidCents };
}
const payoutView = (row: typeof commissionPayout.$inferSelect) => ({
  id: row.id,
  staffId: row.staffId,
  amountCents: row.amountCents,
  reference: row.reference,
  createdAt: row.createdAt.toISOString(),
});
export async function commissionStatement(
  db: Database,
  staffId: string,
  principal: Principal,
  page = 1,
  payoutPage = 1,
) {
  ownStatement(principal, staffId);
  await requireStaff(db, staffId);
  return db.transaction(
    async (tx) => {
      const totals = await balances(tx, staffId);
      const [total] = await tx
        .select({ n: count() })
        .from(commissionAccrual)
        .where(eq(commissionAccrual.staffId, staffId));
      const [payoutTotal] = await tx
        .select({ n: count() })
        .from(commissionPayout)
        .where(eq(commissionPayout.staffId, staffId));
      const rows = await tx.execute<{
        id: string;
        checkout_id: string;
        description: string;
        kind: string;
        basis_cents: number;
        rate_basis_points: number;
        earned_cents: number;
        adjusted_cents: string | number;
        created_at: Date;
      }>(
        sql`select a.id, a.checkout_id, l.description, l.kind, a.basis_cents, a.rate_basis_points, a.earned_cents, ${adjustedEarned} as adjusted_cents, a.created_at from commission_accrual a join checkout c on c.id = a.checkout_id join checkout_line l on l.id = a.checkout_line_id where a.staff_id = ${staffId} order by a.created_at desc, a.id desc limit 20 offset ${(page - 1) * 20}`,
      );
      const payouts = await tx
        .select()
        .from(commissionPayout)
        .where(eq(commissionPayout.staffId, staffId))
        .orderBy(desc(commissionPayout.createdAt), desc(commissionPayout.id))
        .limit(20)
        .offset((payoutPage - 1) * 20);
      return {
        staffId,
        ...totals,
        accruals: rows.map((row) => ({
          id: row.id,
          checkoutId: row.checkout_id,
          description: row.description,
          kind: row.kind,
          basisCents: row.basis_cents,
          rateBasisPoints: row.rate_basis_points,
          originalCents: row.earned_cents,
          adjustedCents: Number(row.adjusted_cents),
          createdAt: new Date(row.created_at).toISOString(),
        })),
        payouts: payouts.map(payoutView),
        pagination: { page, pageSize: 20, total: total?.n ?? 0 },
        payoutPagination: { page: payoutPage, pageSize: 20, total: payoutTotal?.n ?? 0 },
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
export async function recordPayout(
  db: Database,
  staffId: string,
  input: CommissionPayoutInput,
  principal: Principal,
) {
  requirePermission(principal, "manageCommissions");
  await requireStaff(db, staffId);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`commission-payout:${staffId}`}, 0))`,
    );
    const requestHash = createHash("sha256")
      .update(JSON.stringify({ amountCents: input.amountCents, reference: input.reference }))
      .digest("hex");
    const [previous] = await tx
      .select()
      .from(commissionPayout)
      .where(
        and(
          eq(commissionPayout.staffId, staffId),
          eq(commissionPayout.idempotencyKey, input.idempotencyKey),
        ),
      );
    if (previous) {
      if (previous.requestHash !== requestHash)
        throw new DomainError("invalid_state", "Payout key belongs to another request");
      return payoutView(previous);
    }
    const totals = await balances(tx, staffId);
    if (input.amountCents > totals.outstandingCents)
      throw new DomainError("invalid_state", "Payout exceeds outstanding commission");
    const [row] = await tx
      .insert(commissionPayout)
      .values({ ...input, staffId, requestHash, createdBy: principal.userId })
      .returning();
    if (!row) throw new Error("Commission payout insert failed");
    await recordAudit(tx, {
      actorUserId: principal.userId,
      action: "commission.payout_recorded",
      entity: "commission_payout",
      entityId: row.id,
      metadata: { staffId, amountCents: row.amountCents, reference: row.reference },
    });
    return payoutView(row);
  });
}
export async function salesReport(db: Database, query: ReportQuery, principal: Principal) {
  requirePermission(principal, "financialReports");
  const settings = await getSalonSettings(db);
  const timezone = settings.timezone;
  const fromAt = new Date(
    Temporal.PlainDate.from(query.from).toZonedDateTime(timezone).epochMilliseconds,
  );
  const toAt = new Date(
    Temporal.PlainDate.from(query.to).add({ days: 1 }).toZonedDateTime(timezone).epochMilliseconds,
  );
  return db.transaction(
    async (tx) => {
      const staff = query.staffId ? sql`and c.staff_id = ${query.staffId}` : sql``;
      const payments = await tx.execute<{ method: string; amount: string | number }>(
        sql`select p.method::text as method, sum(p.amount_cents)::bigint as amount from checkout_payment p join checkout c on c.id = p.checkout_id where p.status in ('succeeded','reconciliation') and p.updated_at >= ${fromAt} and p.updated_at < ${toAt} ${staff} group by p.method`,
      );
      const refunds = await tx.execute<{ method: string; amount: string | number }>(
        sql`select p.method::text as method, sum(r.amount_cents)::bigint as amount from checkout_refund r join checkout_payment p on p.id = r.payment_id join checkout c on c.id = p.checkout_id where r.status = 'succeeded' and r.updated_at >= ${fromAt} and r.updated_at < ${toAt} ${staff} group by p.method`,
      );
      const [sales] = await tx.execute<{
        sold: string | number;
        tax: string | number;
        tips: string | number;
      }>(
        sql`select coalesce(sum(c.total_cents),0)::bigint as sold, coalesce(sum(c.tax_cents),0)::bigint as tax, coalesce(sum(c.tip_cents),0)::bigint as tips from checkout c where c.fulfilled_at >= ${fromAt} and c.fulfilled_at < ${toAt} and not exists (select 1 from checkout_line gl where gl.checkout_id = c.id and gl.kind = 'gift_card') ${staff}`,
      );
      const [costs] = await tx.execute<{ cost: string | number; unknown: number }>(
        sql`select coalesce(sum(l.quantity * l.unit_cost_cents::bigint),0)::bigint as cost, count(*) filter (where l.unit_cost_cents is null)::int as unknown from checkout_line l join checkout c on c.id = l.checkout_id where l.kind = 'product' and c.fulfilled_at >= ${fromAt} and c.fulfilled_at < ${toAt} ${staff}`,
      );
      const [giftIssued] = await tx.execute<{ amount: string | number }>(
        sql`select coalesce(sum(m.amount_cents),0)::bigint as amount from gift_card_movement m join checkout c on c.id = m.checkout_id where m.kind = 'activation' and m.created_at >= ${fromAt} and m.created_at < ${toAt} ${staff}`,
      );
      const sessions = query.staffId
        ? []
        : await tx
            .select()
            .from(cashSession)
            .where(and(gte(cashSession.openedAt, fromAt), lt(cashSession.openedAt, toAt)))
            .orderBy(desc(cashSession.openedAt));
      const methods = [...new Set([...payments, ...refunds].map((row) => row.method))]
        .sort()
        .map((method) => ({
          method,
          collectedCents: Number(payments.find((row) => row.method === method)?.amount ?? 0),
          refundedCents: Number(refunds.find((row) => row.method === method)?.amount ?? 0),
        }));
      const collectedCents = methods
        .filter((row) => row.method !== "gift_card")
        .reduce((sum, row) => sum + row.collectedCents, 0);
      const refundedCents = methods
        .filter((row) => row.method !== "gift_card")
        .reduce((sum, row) => sum + row.refundedCents, 0);
      return {
        from: query.from,
        to: query.to,
        timezone,
        collectedCents,
        refundedCents,
        netCollectedCents: collectedCents - refundedCents,
        storedValueAppliedCents:
          methods.find((row) => row.method === "gift_card")?.collectedCents ?? 0,
        storedValueReturnedCents:
          methods.find((row) => row.method === "gift_card")?.refundedCents ?? 0,
        giftValueIssuedCents: Number(giftIssued?.amount ?? 0),
        soldCents: Number(sales?.sold ?? 0),
        includedTaxCents: Number(sales?.tax ?? 0),
        tipsCents: Number(sales?.tips ?? 0),
        productCostCents: Number(costs?.cost ?? 0),
        unknownCostLines: costs?.unknown ?? 0,
        methods,
        cashSessions: sessions.map((row) => ({
          id: row.id,
          openedAt: row.openedAt.toISOString(),
          closedAt: row.closedAt?.toISOString() ?? null,
          openingCents: row.openingCents,
          expectedCents: row.expectedCents,
          countedCents: row.countedCents,
          differenceCents:
            row.countedCents !== null && row.expectedCents !== null
              ? row.countedCents - row.expectedCents
              : null,
        })),
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
