import {
  appointment,
  checkout,
  checkoutLine,
  checkoutPayment,
  checkoutRefund,
  passContract,
  passPeriod,
  passRedemption,
  passRefundAllocation,
  passUnit,
} from "@sob/db";
import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { recordAudit } from "../../audit";
import type { Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import type { Tx } from "../../tx";
import { allocateDiscount, multiplyDivide } from "../commerce/money";
import { getCheckoutInTransaction } from "../commerce/service";
import { revokeCardMandate } from "./mandates";
import { periodView } from "./service";
import { allocatedUnits, currentMembershipIndex, membershipCycle, packageExpiry } from "./terms";
export async function lockPeriod(tx: Tx, id: string) {
  const [info] = await tx.select().from(passPeriod).where(eq(passPeriod.id, id));
  if (!info) throw new DomainError("not_found", "Pass period not found");
  const [contract] = await tx
    .select()
    .from(passContract)
    .where(eq(passContract.id, info.contractId))
    .for("update");
  const [period] = await tx.select().from(passPeriod).where(eq(passPeriod.id, id)).for("update");
  if (!contract || !period) throw new Error("Broken pass ownership");
  return { contract, period };
}
export async function activateCheckoutPasses(tx: Tx, checkoutId: string) {
  const lines = await tx.select().from(checkoutLine).where(eq(checkoutLine.checkoutId, checkoutId));
  for (const line of lines) {
    if (!line.passPeriodId) continue;
    const { contract, period } = await lockPeriod(tx, line.passPeriodId);
    if (period.status !== "pending")
      throw new DomainError("invalid_state", "Pass period cannot be activated");
    const paidAt = new Date();
    const anchor = contract.anchorAt ?? paidAt;
    if (contract.kind === "membership" && !contract.periodMonths)
      throw new Error("Membership interval missing");
    const index =
      contract.kind === "membership"
        ? currentMembershipIndex(
            anchor,
            contract.timezone,
            contract.periodMonths ?? 1,
            period.index,
            paidAt,
          )
        : period.index;
    const dates =
      contract.kind === "membership"
        ? membershipCycle(anchor, contract.timezone, contract.periodMonths ?? 1, index)
        : {
            startsAt: paidAt,
            endsAt: packageExpiry(paidAt, contract.timezone, contract.validityDays),
          };
    await tx
      .update(passContract)
      .set({ anchorAt: anchor, status: "active", version: contract.version + 1 })
      .where(eq(passContract.id, contract.id));
    await tx
      .update(passPeriod)
      .set({ status: "active", index, ...dates, version: period.version + 1 })
      .where(eq(passPeriod.id, period.id));
    const amounts = allocatedUnits(period.priceCents, contract.includedUses);
    const taxes = amounts.length ? allocateDiscount(amounts, line.taxCents) : [];
    if (amounts.length)
      await tx.insert(passUnit).values(
        amounts.map((allocatedCents, ordinal) => ({
          periodId: period.id,
          ordinal,
          allocatedCents,
          taxCents: taxes[ordinal] ?? 0,
        })),
      );
    await recordAudit(tx, {
      actorUserId: null,
      action: "pass.period_activated",
      entity: "pass_period",
      entityId: period.id,
      metadata: { checkoutId, includedUses: contract.includedUses },
    });
  }
}
export async function voidCheckoutPasses(
  tx: Tx,
  checkoutId: string,
  actorUserId: string | null = null,
) {
  const lines = await tx.select().from(checkoutLine).where(eq(checkoutLine.checkoutId, checkoutId));
  for (const line of lines) {
    if (!line.passPeriodId) continue;
    const { period, contract } = await lockPeriod(tx, line.passPeriodId);
    if (period.status !== "pending")
      throw new DomainError("invalid_state", "Paid pass cannot be voided");
    await tx
      .update(passPeriod)
      .set({ status: "void", version: period.version + 1 })
      .where(eq(passPeriod.id, period.id));
    if (contract.kind === "membership") {
      await revokeCardMandate(tx, contract.id);
      await tx
        .update(passContract)
        .set({
          ...(period.index === 0 ? { status: "void" } : {}),
          cancelAtPeriodEnd: true,
          autoPayReady: false,
          version: contract.version + 1,
        })
        .where(eq(passContract.id, contract.id));
      await recordAudit(tx, {
        actorUserId,
        action: "membership.renewal_stopped",
        entity: "pass_contract",
        entityId: contract.id,
        metadata: { reason: "unpaid_invoice_cancelled", checkoutId },
      });
    } else if (period.index === 0)
      await tx
        .update(passContract)
        .set({ status: "void", version: contract.version + 1 })
        .where(eq(passContract.id, contract.id));
  }
}
function validAt(period: typeof passPeriod.$inferSelect, date: Date) {
  return (
    period.status === "active" &&
    period.startsAt !== null &&
    period.startsAt <= date &&
    (!period.endsAt || period.endsAt > date)
  );
}
export async function redeemPass(
  tx: Tx,
  input: { method: string; passPeriodId?: string; checkoutLineId?: string; amountCents: number },
  paymentId: string,
  checkoutId: string,
  p: Principal,
) {
  const [sale] = await tx.select().from(checkout).where(eq(checkout.id, checkoutId));
  const [line] = await tx
    .select()
    .from(checkoutLine)
    .where(
      and(eq(checkoutLine.id, input.checkoutLineId ?? ""), eq(checkoutLine.checkoutId, checkoutId)),
    );
  if (!sale?.appointmentId || !line?.serviceId || line.kind !== "service")
    throw new DomainError("invalid_state", "Passes cover only eligible booked service lines");
  const [booking] = await tx
    .select()
    .from(appointment)
    .where(eq(appointment.id, sale.appointmentId));
  const { contract, period } = await lockPeriod(tx, input.passPeriodId ?? "");
  if (
    contract.clientId !== sale.clientId ||
    contract.kind !== input.method ||
    !booking ||
    booking.status === "cancelled" ||
    !validAt(period, booking.startsAt) ||
    !contract.serviceIds.includes(line.serviceId) ||
    input.amountCents !== line.quantity * line.unitAmountCents - line.discountCents
  )
    throw new DomainError(
      "invalid_state",
      "Pass, service, service date or visit amount is not eligible",
    );
  const [used] = await tx
    .select()
    .from(passRedemption)
    .where(and(eq(passRedemption.checkoutLineId, line.id), isNull(passRedemption.refundedAt)))
    .limit(1);
  if (used) throw new DomainError("invalid_state", "This service already used a pass visit");
  const [unit] = await tx
    .select()
    .from(passUnit)
    .where(and(eq(passUnit.periodId, period.id), eq(passUnit.status, "available")))
    .orderBy(asc(passUnit.ordinal))
    .limit(1)
    .for("update");
  if (!unit) throw new DomainError("invalid_state", "No available funded visits remain");
  await tx.update(passUnit).set({ status: "used", paymentId }).where(eq(passUnit.id, unit.id));
  await tx.insert(passRedemption).values({
    unitId: unit.id,
    periodId: period.id,
    checkoutId,
    checkoutLineId: line.id,
    paymentId,
    amountCents: input.amountCents,
    allocatedCents: unit.allocatedCents,
    taxCents: unit.taxCents,
  });
  await tx
    .update(passPeriod)
    .set({ version: period.version + 1 })
    .where(eq(passPeriod.id, period.id));
  await recordAudit(tx, {
    actorUserId: p.userId,
    action: "pass.visit_redeemed",
    entity: "pass_period",
    entityId: period.id,
    metadata: { checkoutId, paymentId, unitId: unit.id, allocatedCents: unit.allocatedCents },
  });
}
async function refundable(tx: Tx, periodId: string, excludeRefundId?: string) {
  const { period, contract } = await lockPeriod(tx, periodId);
  const [line] = await tx
    .select()
    .from(checkoutLine)
    .where(eq(checkoutLine.passPeriodId, periodId));
  if (!line) throw new Error("Period invoice missing");
  const payments = await tx
    .select()
    .from(checkoutPayment)
    .where(eq(checkoutPayment.checkoutId, line.checkoutId));
  const refunds = payments.length
    ? await tx
        .select()
        .from(checkoutRefund)
        .where(
          inArray(
            checkoutRefund.paymentId,
            payments.map((p) => p.id),
          ),
        )
    : [];
  const captured = payments
    .filter((p) => p.status === "succeeded" || p.status === "reconciliation")
    .reduce((sum, p) => sum + p.amountCents, 0);
  const reserved = refunds
    .filter((r) => r.status !== "failed" && r.id !== excludeRefundId)
    .reduce((sum, r) => sum + r.amountCents, 0);
  const units = await tx
    .select()
    .from(passUnit)
    .where(eq(passUnit.periodId, periodId))
    .orderBy(asc(passUnit.ordinal));
  const funded =
    period.status === "pending"
      ? 0
      : contract.includedUses === 0
        ? period.status === "active"
          ? period.priceCents
          : 0
        : units.filter((u) => u.status !== "retired").reduce((sum, u) => sum + u.allocatedCents, 0);
  // Held asset refunds are still funded until applied; only their non-asset component reserves excess.
  const allocations = await tx
    .select()
    .from(passRefundAllocation)
    .where(
      and(eq(passRefundAllocation.periodId, periodId), eq(passRefundAllocation.status, "held")),
    );
  const heldAsset = allocations.reduce(
    (sum, a) =>
      sum +
      units.filter((u) => a.unitIds.includes(u.id)).reduce((n, u) => n + u.allocatedCents, 0) +
      (contract.includedUses === 0 && a.unitIds.length === 0
        ? Math.max(0, (refunds.find((r) => r.id === a.refundId)?.amountCents ?? 0) - a.excessCents)
        : 0),
    0,
  );
  return {
    period,
    contract,
    line,
    payments,
    refunds,
    units,
    excess: Math.max(0, captured - reserved + heldAsset - funded),
  };
}
export async function refundQuote(tx: Tx, periodId: string, paymentId: string, unitCount: number) {
  const data = await refundable(tx, periodId);
  const payment = data.payments.find((p) => p.id === paymentId);
  if (!payment || !["succeeded", "reconciliation"].includes(payment.status))
    throw new DomainError("not_found", "Captured purchase payment not found");
  const available = data.units.filter((u) => u.status === "available");
  if (unitCount > available.length)
    throw new DomainError("invalid_state", "Not enough unused visits to return");
  const remaining =
    payment.amountCents -
    data.refunds
      .filter((r) => r.paymentId === paymentId && r.status !== "failed")
      .reduce((sum, r) => sum + r.amountCents, 0);
  const excess = Math.min(data.excess, remaining);
  const asset =
    data.contract.includedUses === 0 && data.period.status === "active"
      ? Math.min(data.period.priceCents, remaining - excess)
      : available.slice(0, unitCount).reduce((sum, u) => sum + u.allocatedCents, 0);
  const amountCents = asset + excess;
  if (amountCents > remaining)
    throw new DomainError(
      "invalid_state",
      "Selected visits exceed this payment's refundable amount",
    );
  return {
    amountCents,
    unitCount,
    excessCents: excess,
    availableUses: available.length,
    accessFee: data.contract.kind === "membership" && data.contract.includedUses === 0,
  };
}
/** Reserve unused whole visits before any bank refund can leave this transaction. */
export async function preparePassRefund(
  tx: Tx,
  refund: typeof checkoutRefund.$inferSelect,
  payment: typeof checkoutPayment.$inferSelect,
) {
  if (payment.method === "package" || payment.method === "membership") {
    if (refund.amountCents !== payment.amountCents)
      throw new DomainError("invalid_state", "Pass redemptions must return the entire visit");
    return;
  }
  const [line] = await tx
    .select()
    .from(checkoutLine)
    .where(eq(checkoutLine.checkoutId, payment.checkoutId));
  if (!line?.passPeriodId) return;
  // The newly inserted refund is not yet a reservation until this allocation is created.
  const data = await refundable(tx, line.passPeriodId, refund.id);
  const excess = Math.min(data.excess, refund.amountCents);
  let needed = refund.amountCents - excess;
  const selected: (typeof passUnit.$inferSelect)[] = [];
  for (const unit of data.units) {
    if (!needed) break;
    if (unit.status !== "available") continue;
    if (unit.allocatedCents > needed) break;
    selected.push(unit);
    needed -= unit.allocatedCents;
  }
  if (
    data.contract.includedUses === 0 &&
    data.period.status === "active" &&
    needed > 0 &&
    needed <= data.period.priceCents
  )
    needed = 0;
  if (needed !== 0)
    throw new DomainError(
      "invalid_state",
      "Purchase refunds must return unused whole visit allocations",
    );
  await tx.insert(passRefundAllocation).values({
    periodId: data.period.id,
    refundId: refund.id,
    unitIds: selected.map((u) => u.id),
    excessCents: excess,
  });
  if (selected.length)
    await tx
      .update(passUnit)
      .set({ status: "held", refundId: refund.id })
      .where(
        inArray(
          passUnit.id,
          selected.map((u) => u.id),
        ),
      );
}
export async function syncCheckoutPassRefunds(tx: Tx, checkoutId: string) {
  // Tender returns restore the same unit; a previous purchase refund can never make it spendable again.
  const redemptions = await tx
    .select()
    .from(passRedemption)
    .where(and(eq(passRedemption.checkoutId, checkoutId), isNull(passRedemption.refundedAt)));
  for (const r of redemptions) {
    const [returned] = await tx
      .select()
      .from(checkoutRefund)
      .where(and(eq(checkoutRefund.paymentId, r.paymentId), eq(checkoutRefund.status, "succeeded")))
      .limit(1);
    if (!returned) continue;
    const { period } = await lockPeriod(tx, r.periodId);
    await tx
      .update(passUnit)
      .set({ status: "available", paymentId: null })
      .where(
        and(
          eq(passUnit.id, r.unitId),
          eq(passUnit.status, "used"),
          eq(passUnit.paymentId, r.paymentId),
        ),
      );
    await tx
      .update(passRedemption)
      .set({ refundedAt: new Date() })
      .where(eq(passRedemption.id, r.id));
    await tx
      .update(passPeriod)
      .set({ version: period.version + 1 })
      .where(eq(passPeriod.id, period.id));
  }
  let closed = false;
  const lines = await tx.select().from(checkoutLine).where(eq(checkoutLine.checkoutId, checkoutId));
  for (const line of lines) {
    if (!line.passPeriodId) continue;
    const { period, contract } = await lockPeriod(tx, line.passPeriodId);
    const allocations = await tx
      .select({ allocation: passRefundAllocation, refund: checkoutRefund })
      .from(passRefundAllocation)
      .innerJoin(checkoutRefund, eq(checkoutRefund.id, passRefundAllocation.refundId))
      .where(
        and(eq(passRefundAllocation.periodId, period.id), eq(passRefundAllocation.status, "held")),
      );
    let feeReturned = false;
    for (const { allocation: a, refund: r } of allocations) {
      if (r.status !== "succeeded" && r.status !== "failed") continue;
      const succeeded = r.status === "succeeded";
      if (a.unitIds.length)
        await tx
          .update(passUnit)
          .set({ status: succeeded ? "retired" : "available", refundId: succeeded ? r.id : null })
          .where(
            and(
              inArray(passUnit.id, a.unitIds),
              eq(passUnit.status, "held"),
              eq(passUnit.refundId, r.id),
            ),
          );
      await tx
        .update(passRefundAllocation)
        .set({ status: succeeded ? "applied" : "released" })
        .where(eq(passRefundAllocation.id, a.id));
      feeReturned ||= succeeded && contract.includedUses === 0 && r.amountCents - a.excessCents > 0;
    }
    const units = await tx.select().from(passUnit).where(eq(passUnit.periodId, period.id));
    const payments = await tx
      .select()
      .from(checkoutPayment)
      .where(eq(checkoutPayment.checkoutId, checkoutId));
    const refunds = payments.length
      ? await tx
          .select()
          .from(checkoutRefund)
          .where(
            inArray(
              checkoutRefund.paymentId,
              payments.map((p) => p.id),
            ),
          )
      : [];
    const captured = payments
      .filter((p) => p.status === "succeeded" || p.status === "reconciliation")
      .reduce((sum, p) => sum + p.amountCents, 0);
    const returned = refunds
      .filter((r) => r.status === "succeeded")
      .reduce((sum, r) => sum + r.amountCents, 0);
    const allReturned =
      period.status === "pending" &&
      captured > 0 &&
      returned >= captured &&
      !payments.some((p) => p.status === "pending");
    if (
      allReturned ||
      feeReturned ||
      (units.length > 0 && units.every((u) => u.status === "retired"))
    ) {
      await tx
        .update(passPeriod)
        .set({ status: "void", version: period.version + 1 })
        .where(eq(passPeriod.id, period.id));
      const [other] = await tx
        .select({ id: passPeriod.id })
        .from(passPeriod)
        .where(
          and(
            eq(passPeriod.contractId, contract.id),
            sql`${passPeriod.id}<>${period.id}`,
            eq(passPeriod.status, "active"),
            or(isNull(passPeriod.endsAt), gt(passPeriod.endsAt, new Date())),
          ),
        )
        .limit(1);
      if (contract.kind === "membership") await revokeCardMandate(tx, contract.id);
      await tx
        .update(passContract)
        .set({
          ...(!other ? { status: "void", autoPayReady: false } : {}),
          ...(contract.kind === "membership"
            ? { cancelAtPeriodEnd: true, autoPayReady: false }
            : {}),
          version: contract.version + 1,
        })
        .where(eq(passContract.id, contract.id));
      await tx.update(checkout).set({ status: "void" }).where(eq(checkout.id, checkoutId));
      closed = true;
    } else if (allocations.length)
      await tx
        .update(passPeriod)
        .set({ version: period.version + 1 })
        .where(eq(passPeriod.id, period.id));
  }
  return closed;
}
export async function membershipDiscounts(
  tx: Tx,
  clientId: string | null,
  appointmentId: string | undefined,
  lines: { kind: string; serviceId?: string | null; quantity: number; unitAmountCents: number }[],
  proposedStartsAt?: Date,
) {
  if (!clientId || (!appointmentId && !proposedStartsAt))
    return lines.map(() => ({ amountCents: 0, periodId: null as string | null }));
  const [booking] = proposedStartsAt
    ? [{ startsAt: proposedStartsAt }]
    : appointmentId
      ? await tx.select().from(appointment).where(eq(appointment.id, appointmentId))
      : [];
  if (!booking) return lines.map(() => ({ amountCents: 0, periodId: null as string | null }));
  const candidates = await tx
    .select({ contract: passContract, period: passPeriod })
    .from(passPeriod)
    .innerJoin(passContract, eq(passContract.id, passPeriod.contractId))
    .where(
      and(
        eq(passContract.clientId, clientId),
        eq(passContract.kind, "membership"),
        eq(passPeriod.status, "active"),
        sql`not exists (select 1 from pass_refund_allocation a join checkout_refund r on r.id=a.refund_id where a.period_id=${passPeriod.id} and a.status='held' and r.amount_cents>a.excess_cents)`,
      ),
    );
  return lines.map((line) => {
    const best =
      line.kind === "service" && line.serviceId
        ? candidates
            .filter(
              (c) =>
                validAt(c.period, booking.startsAt) &&
                c.contract.serviceIds.includes(line.serviceId ?? ""),
            )
            .sort(
              (a, b) =>
                b.contract.discountBasisPoints - a.contract.discountBasisPoints ||
                a.period.id.localeCompare(b.period.id),
            )[0]
        : undefined;
    return {
      amountCents: best
        ? multiplyDivide(
            line.quantity * line.unitAmountCents,
            best.contract.discountBasisPoints,
            10000,
          )
        : 0,
      periodId: best?.period.id ?? null,
    };
  });
}
export async function eligiblePasses(tx: Tx, checkoutId: string, p: Principal) {
  const sale = await getCheckoutInTransaction(tx, checkoutId, p);
  if (!sale.appointmentId || !sale.clientId) return { eligible: [] };
  const [booking] = await tx
    .select()
    .from(appointment)
    .where(eq(appointment.id, sale.appointmentId));
  if (!booking || booking.status === "cancelled") return { eligible: [] };
  const candidates = await tx
    .select({ contract: passContract, period: passPeriod })
    .from(passPeriod)
    .innerJoin(passContract, eq(passContract.id, passPeriod.contractId))
    .where(and(eq(passContract.clientId, sale.clientId), eq(passPeriod.status, "active")))
    .orderBy(asc(passPeriod.endsAt), asc(passPeriod.createdAt));
  const eligible = [];
  for (const c of candidates) {
    if (!validAt(c.period, booking.startsAt)) continue;
    const view = await periodView(tx, c.period);
    if (!view.availableUses) continue;
    const rows = await tx
      .select()
      .from(checkoutLine)
      .where(eq(checkoutLine.checkoutId, checkoutId));
    const used = await tx
      .select()
      .from(passRedemption)
      .where(and(eq(passRedemption.checkoutId, checkoutId), isNull(passRedemption.refundedAt)));
    const lines = rows
      .filter(
        (l) =>
          l.kind === "service" &&
          l.serviceId &&
          c.contract.serviceIds.includes(l.serviceId) &&
          !used.some((r) => r.checkoutLineId === l.id),
      )
      .map((l) => ({
        id: l.id,
        description: l.description,
        amountCents: l.quantity * l.unitAmountCents - l.discountCents,
      }))
      .filter((l) => l.amountCents > 0 && l.amountCents <= sale.balanceCents);
    if (lines.length)
      eligible.push({
        period: view,
        passId: c.contract.id,
        name: c.contract.name,
        kind: c.contract.kind as "package" | "membership",
        lines,
      });
  }
  return { eligible };
}
