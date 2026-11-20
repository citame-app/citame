import { createHash } from "node:crypto";
import {
  type BookingProtection,
  type CreateAppointmentRequest,
  needsFinalPrice,
  permissionsFor,
} from "@sob/contracts";
import {
  appointment,
  appointmentService,
  bookingFeeMovement,
  bookingProtection,
  checkout,
  checkoutLine,
  clientProfile,
  type Database,
  staffProfile,
  user,
} from "@sob/db";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { DomainError } from "../../errors";
import { closeAppointment, scheduleNewAppointment } from "../../notifications/outbox";
import { lockScheduling, type Tx } from "../../tx";
import type { Actor } from "../appointments/service";
import { membershipDiscounts } from "../passes/value";
import { releaseCheckoutReward } from "../rewards/value";
import { getBookingPolicy } from "./policy";

type Connection = Database | Tx;
type Booking = typeof appointment.$inferSelect;
const terminal = (state: string) => ["cancelled", "expired", "no_show"].includes(state);
async function funds(db: Connection, checkoutId: string) {
  const [r] = await db.execute<{ paid: string; refunded: string; held: string }>(sql`select
    (select coalesce(sum(p.amount_cents),0) from checkout_payment p where p.checkout_id=${checkoutId} and p.status in ('succeeded','reconciliation'))::text as paid,
    (select coalesce(sum(r.amount_cents),0) from checkout_refund r join checkout_payment p on p.id=r.payment_id where p.checkout_id=${checkoutId} and r.status='succeeded')::text as refunded,
    (select coalesce(sum(r.amount_cents),0) from checkout_refund r join checkout_payment p on p.id=r.payment_id where p.checkout_id=${checkoutId} and r.status in ('requested','dispatched','reconciliation'))::text as held`);
  return {
    paid: Number(r?.paid ?? 0),
    refunded: Number(r?.refunded ?? 0),
    held: Number(r?.held ?? 0),
  };
}
export async function protectionView(
  db: Connection,
  appointmentId: string,
): Promise<BookingProtection | null> {
  const [row] = await db
    .select()
    .from(bookingProtection)
    .where(eq(bookingProtection.appointmentId, appointmentId));
  if (!row) return null;
  const money = terminal(row.state) ? await funds(db, row.checkoutId) : { paid: 0, refunded: 0 };
  return {
    checkoutId: row.checkoutId,
    state: row.state,
    depositCents: row.depositCents,
    policyVersion: row.policyVersion,
    expiresAt: row.expiresAt.toISOString(),
    cancellationCutoff: row.cancellationCutoff.toISOString(),
    lateCancellationBasisPoints: row.terms.lateCancellationBasisPoints,
    noShowBasisPoints: row.terms.noShowBasisPoints,
    feeCents: row.feeCents,
    refundDueCents: terminal(row.state)
      ? Math.max(0, money.paid - money.refunded - row.feeCents)
      : 0,
  };
}
export async function createProtection(
  tx: Tx,
  booking: Booking,
  request: CreateAppointmentRequest,
  actor: Actor | undefined,
  now: Date,
) {
  const policy = await getBookingPolicy(tx);
  if (!policy.enabled) return null;
  const [client] = await tx
    .select()
    .from(clientProfile)
    .where(eq(clientProfile.id, booking.clientId));
  const [caller] = actor ? await tx.select().from(user).where(eq(user.id, actor.userId)) : [];
  const [staff] =
    caller?.role === "staff"
      ? await tx
          .select()
          .from(staffProfile)
          .where(and(eq(staffProfile.userId, caller.id), isNull(staffProfile.deletedAt)))
      : [];
  const trusted = policy.trustedExempt && client?.bookingAccess === "trusted";
  const explicitWaiver = Boolean(
    request.protectionWaiverReason &&
      caller &&
      permissionsFor(caller.role, staff?.accessPreset).refunds,
  );
  if (request.protectionWaiverReason && !explicitWaiver)
    throw new DomainError("forbidden", "Only managers may waive a booking deposit");
  const waived = trusted || explicitWaiver;
  if (
    !waived &&
    (caller?.role !== "client" ||
      client?.userId !== caller.id ||
      request.protectionAcceptedVersion !== policy.version)
  )
    throw new DomainError(
      "invalid_state",
      "Accept the current booking policy, or ask a manager to record a deposit waiver",
    );
  const snapshots = await tx
    .select()
    .from(appointmentService)
    .where(eq(appointmentService.appointmentId, booking.id));
  const subtotalCents = snapshots.reduce((sum, s) => sum + s.priceCents, 0);
  const discounts = await membershipDiscounts(
    tx,
    booking.clientId,
    booking.id,
    snapshots.map((s) => ({
      kind: "service",
      serviceId: s.serviceId,
      quantity: 1,
      unitAmountCents: s.priceCents,
    })),
  );
  const [promotionalSale] = request.promotion
    ? await tx.select().from(checkout).where(eq(checkout.appointmentId, booking.id))
    : [];
  if (request.promotion && !promotionalSale) throw new Error("Missing reviewed promotion receipt");
  const discountCents =
    promotionalSale?.discountCents ?? discounts.reduce((sum, d) => sum + d.amountCents, 0);
  let totalCents = promotionalSale?.totalCents ?? subtotalCents - discountCents;
  const pendingPrices = snapshots.some((s) => needsFinalPrice(s.priceType));
  const unknownPrice = snapshots.some((s) => s.priceType === "variable");
  if (unknownPrice && !waived && policy.depositKind !== "fixed")
    throw new DomainError(
      "invalid_state",
      "Variable-price services require a fixed deposit amount instead of a percentage",
    );
  if (
    !waived &&
    request.protectionAcceptedTotalCents !== (request.promotion ? totalCents : subtotalCents)
  )
    throw new DomainError(
      "invalid_state",
      "Service prices changed; review the current total and accept again",
    );
  if (
    !snapshots.length ||
    snapshots.some((s) => s.currency !== "EUR") ||
    (subtotalCents <= 0 && !unknownPrice && !snapshots.every((s) => s.priceType === "free")) ||
    totalCents > 999999999
  )
    throw new DomainError(
      "validation_error",
      "Protected bookings need a positive EUR service total",
    );
  // Unknown final prices reserve only the explicitly accepted fixed deposit. This provisional
  // amount is never fulfilled as a service sale; the team must set the final price in checkout.
  const provisionalExtra =
    unknownPrice && !waived ? Math.max(0, policy.depositValue - totalCents) : 0;
  const receiptSubtotalCents = subtotalCents + provisionalExtra;
  totalCents += provisionalExtra;
  const noDeposit = waived || totalCents === 0;
  const depositCents = noDeposit
    ? 0
    : Math.min(
        totalCents,
        policy.depositKind === "fixed"
          ? policy.depositValue
          : Math.max(1, Math.ceil((totalCents * policy.depositValue) / 10000)),
      );
  if (unknownPrice && !waived && request.protectionAcceptedDepositCents !== depositCents)
    throw new DomainError(
      "invalid_state",
      "Review and accept the exact fixed deposit for this variable-price service",
    );
  let sale = promotionalSale;
  if (!sale) {
    const [created] = await tx
      .insert(checkout)
      .values({
        appointmentId: booking.id,
        clientId: booking.clientId,
        staffId: booking.staffId,
        subtotalCents: receiptSubtotalCents,
        discountCents,
        totalCents,
        status: totalCents === 0 && !pendingPrices ? "paid" : "open",
        createdBy: actor?.userId,
        idempotencyKey: `booking-${booking.id}`,
        requestHash: createHash("sha256").update(`booking:${booking.id}`).digest("hex"),
      })
      .returning();
    if (!created) throw new Error("Protected receipt insert failed");
    let provisionalAssigned = false;
    await tx.insert(checkoutLine).values(
      snapshots.map((s, index) => {
        const extra = s.priceType === "variable" && !provisionalAssigned ? provisionalExtra : 0;
        if (s.priceType === "variable") provisionalAssigned = true;
        return {
          checkoutId: created.id,
          kind: "service",
          serviceId: s.serviceId,
          description: s.name,
          quantity: 1,
          unitAmountCents: s.priceCents + extra,
          pricePending: needsFinalPrice(s.priceType),
          minimumUnitAmountCents: s.priceType === "from" ? s.priceCents : 0,
          discountCents: discounts[index]?.amountCents ?? 0,
          membershipPeriodId: discounts[index]?.periodId,
        };
      }),
    );
    sale = created;
  }
  const expiresAt = new Date(
    Math.min(now.getTime() + policy.holdMinutes * 60000, booking.startsAt.getTime()),
  );
  await tx.insert(bookingProtection).values({
    appointmentId: booking.id,
    checkoutId: sale.id,
    state: noDeposit ? "waived" : "pending",
    terms: policy,
    policyVersion: policy.version,
    depositCents,
    expiresAt,
    cancellationCutoff: new Date(
      booking.startsAt.getTime() - policy.cancellationWindowMinutes * 60000,
    ),
    acceptedBy: !waived ? actor?.userId : null,
    acceptedAt: !waived ? now : null,
    waiverReason: explicitWaiver
      ? request.protectionWaiverReason
      : trusted
        ? "Trusted customer exemption"
        : null,
  });
  await recordAudit(tx, {
    actorUserId: actor?.userId ?? null,
    action: noDeposit ? "booking.deposit_waived" : "booking.deposit_required",
    entity: "appointment",
    entityId: booking.id,
    metadata: {
      depositCents,
      policyVersion: policy.version,
      expiresAt: expiresAt.toISOString(),
      ...(explicitWaiver ? { reason: request.protectionWaiverReason } : {}),
    },
  });
  return protectionView(tx, booking.id);
}
/** Receipts are locked before appointment rows throughout payment and lifecycle operations. */
export async function lockProtectionReceipt(tx: Tx, appointmentId: string) {
  await tx
    .select({ id: checkout.id })
    .from(checkout)
    .where(eq(checkout.appointmentId, appointmentId))
    .orderBy(asc(checkout.id))
    .for("update");
  await lockScheduling(tx);
}
export async function protectedPayable(
  db: Connection,
  sale: typeof checkout.$inferSelect,
  balance: number,
  now = new Date(),
) {
  if (!sale.appointmentId) return balance;
  const [p] = await db
    .select()
    .from(bookingProtection)
    .where(eq(bookingProtection.checkoutId, sale.id));
  if (!p) return balance;
  if (terminal(p.state) || (p.state === "pending" && p.expiresAt <= now)) return 0;
  const [a] = await db.select().from(appointment).where(eq(appointment.id, p.appointmentId));
  if (!a || a.status === "cancelled" || a.status === "no_show") return 0;
  if (p.state === "waived" || a.status === "completed") return balance;
  const money = await funds(db, sale.id);
  return Math.min(balance, Math.max(0, p.depositCents - (money.paid - money.refunded)));
}
export async function assertProtectedPayment(
  tx: Tx,
  sale: typeof checkout.$inferSelect,
  amount: number,
  method: string,
  balance: number,
  now: Date,
) {
  if (!sale.appointmentId) return;
  const [p] = await tx
    .select()
    .from(bookingProtection)
    .where(eq(bookingProtection.checkoutId, sale.id));
  if (!p) return;
  if (
    (p.state === "pending" && ["package", "membership"].includes(method)) ||
    amount > (await protectedPayable(tx, sale, balance, now))
  )
    throw new DomainError(
      "invalid_state",
      "Only the required deposit can be paid before the visit; expired or closed holds cannot be paid",
    );
}
export async function canFulfillProtected(tx: Tx, sale: typeof checkout.$inferSelect) {
  if (!sale.appointmentId) return true;
  const [p] = await tx
    .select()
    .from(bookingProtection)
    .where(eq(bookingProtection.checkoutId, sale.id));
  if (!p && sale.idempotencyKey !== `booking-promotion-${sale.appointmentId}`) return true;
  const [a] = await tx
    .select()
    .from(appointment)
    .where(eq(appointment.id, p?.appointmentId ?? sale.appointmentId));
  return a?.status === "completed";
}
/** Called under the receipt lock after every payment/refund state change. */
export async function syncProtectionPayment(tx: Tx, checkoutId: string, now = new Date()) {
  const [p] = await tx
    .select()
    .from(bookingProtection)
    .where(eq(bookingProtection.checkoutId, checkoutId));
  if (!p) return;
  const money = await funds(tx, checkoutId);
  const net = Math.max(0, money.paid - money.refunded);
  if (["pending", "confirmed"].includes(p.state) && money.refunded > 0 && net < p.depositCents) {
    const [before] = await tx
      .select()
      .from(appointment)
      .where(eq(appointment.id, p.appointmentId))
      .for("update");
    if (before?.status !== "booked") return;
    await finishProtection(
      tx,
      before,
      p.expiresAt <= now ? "expired" : "cancelled",
      now,
      null,
      true,
    );
    const [a] = await tx
      .update(appointment)
      .set({ status: "cancelled", version: sql`${appointment.version} + 1` })
      .where(and(eq(appointment.id, p.appointmentId), eq(appointment.status, "booked")))
      .returning();
    if (a) await closeAppointment(tx, a, now, { notify: p.state === "confirmed" });
    return;
  }
  if (terminal(p.state)) {
    const fee = Math.min(p.feeCents, net);
    if (fee < p.feeCents) {
      await tx
        .insert(bookingFeeMovement)
        .values({ appointmentId: p.appointmentId, checkoutId, amountCents: fee - p.feeCents });
      await tx
        .update(bookingProtection)
        .set({ feeCents: fee })
        .where(eq(bookingProtection.appointmentId, p.appointmentId));
    }
    return;
  }
  if (p.state === "pending" && p.expiresAt > now && net >= p.depositCents) {
    await tx
      .update(bookingProtection)
      .set({ state: "confirmed" })
      .where(eq(bookingProtection.appointmentId, p.appointmentId));
    const [a] = await tx
      .update(appointment)
      .set({ version: sql`${appointment.version} + 1` })
      .where(and(eq(appointment.id, p.appointmentId), eq(appointment.status, "booked")))
      .returning();
    if (a) await scheduleNewAppointment(tx, a, now);
    await recordAudit(tx, {
      actorUserId: null,
      action: "booking.deposit_confirmed",
      entity: "appointment",
      entityId: p.appointmentId,
      metadata: { depositCents: p.depositCents },
    });
  }
}
export async function finishProtection(
  tx: Tx,
  booking: Booking,
  target: "cancelled" | "no_show" | "expired",
  now: Date,
  actorUserId: string | null,
  forceWaive = false,
) {
  const [p] = await tx
    .select()
    .from(bookingProtection)
    .where(eq(bookingProtection.appointmentId, booking.id));
  if (!p || terminal(p.state)) return;
  const money = await funds(tx, p.checkoutId);
  const [sale] = await tx.select().from(checkout).where(eq(checkout.id, p.checkoutId));
  const rate =
    forceWaive || p.state === "waived" || target === "expired"
      ? 0
      : target === "no_show"
        ? p.terms.noShowBasisPoints
        : now >= p.cancellationCutoff
          ? p.terms.lateCancellationBasisPoints
          : 0;
  const feeCents = Math.min(
    p.depositCents,
    Math.max(0, money.paid - money.refunded),
    Math.floor(((sale?.totalCents ?? 0) * rate) / 10000),
  );
  await tx
    .update(bookingProtection)
    .set({ state: target, feeCents, finalisedAt: now })
    .where(eq(bookingProtection.appointmentId, booking.id));
  await tx.update(checkout).set({ status: "void" }).where(eq(checkout.id, p.checkoutId));
  await releaseCheckoutReward(tx, p.checkoutId);
  if (feeCents)
    await tx.insert(bookingFeeMovement).values({
      appointmentId: booking.id,
      checkoutId: p.checkoutId,
      amountCents: feeCents,
      createdAt: now,
    });
  await recordAudit(tx, {
    actorUserId,
    action: `booking.deposit_${target}`,
    entity: "appointment",
    entityId: booking.id,
    metadata: { feeCents, policyVersion: p.policyVersion },
  });
}
export async function updateProtection(
  tx: Tx,
  before: Booking,
  after: Booking,
  now: Date,
  actor?: Actor,
) {
  const [p] = await tx
    .select()
    .from(bookingProtection)
    .where(eq(bookingProtection.appointmentId, after.id));
  if (!p) return;
  if ((terminal(p.state) || p.state === "completed") && after.status !== before.status)
    throw new DomainError(
      "invalid_state",
      "A closed protected booking cannot be reopened; create a new appointment",
    );
  if (p.state === "pending" && p.expiresAt <= now && after.status !== "cancelled")
    throw new DomainError("invalid_state", "The deposit hold has expired");
  if (["completed", "no_show"].includes(after.status) && p.state === "pending")
    throw new DomainError(
      "invalid_state",
      "Confirm the required deposit or cancel the unpaid hold",
    );
  if (after.status === "cancelled" || after.status === "no_show")
    await finishProtection(tx, after, after.status, now, actor?.userId ?? null);
  else if (after.status === "completed")
    await tx
      .update(bookingProtection)
      .set({ state: "completed", finalisedAt: now })
      .where(eq(bookingProtection.appointmentId, after.id));
  else if (before.startsAt.getTime() !== after.startsAt.getTime()) {
    // Rescheduling cannot move a customer past a fee deadline and then cancel for free.
    if (now >= p.cancellationCutoff && p.terms.lateCancellationBasisPoints > 0)
      throw new DomainError(
        "invalid_state",
        "Reschedule before the cancellation deadline or ask the salon to cancel and review the deposit",
      );
    await tx
      .update(bookingProtection)
      .set({
        cancellationCutoff: new Date(
          after.startsAt.getTime() - p.terms.cancellationWindowMinutes * 60000,
        ),
        expiresAt: new Date(Math.min(p.expiresAt.getTime(), after.startsAt.getTime())),
      })
      .where(eq(bookingProtection.appointmentId, after.id));
  }
}
export async function expireBookingHolds(db: Database, now = new Date(), limit = 100) {
  const candidates = await db
    .select()
    .from(bookingProtection)
    .where(
      and(eq(bookingProtection.state, "pending"), sql`${bookingProtection.expiresAt} <= ${now}`),
    )
    .limit(limit);
  let expired = 0;
  for (const candidate of candidates)
    await db.transaction(async (tx) => {
      await lockProtectionReceipt(tx, candidate.appointmentId);
      const [p] = await tx
        .select()
        .from(bookingProtection)
        .where(eq(bookingProtection.appointmentId, candidate.appointmentId));
      if (p?.state !== "pending" || p.expiresAt > now) return;
      const [a] = await tx
        .select()
        .from(appointment)
        .where(eq(appointment.id, p.appointmentId))
        .for("update");
      if (a?.status !== "booked") return;
      await finishProtection(tx, a, "expired", now, null);
      const [updated] = await tx
        .update(appointment)
        .set({ status: "cancelled", version: sql`${appointment.version} + 1` })
        .where(eq(appointment.id, a.id))
        .returning();
      if (updated) await closeAppointment(tx, updated, now, { notify: false });
      expired++;
    });
  return expired;
}

export async function closeExpiredProtection(
  tx: Tx,
  sale: typeof checkout.$inferSelect,
  now: Date,
) {
  if (!sale.appointmentId) return false;
  const [p] = await tx
    .select()
    .from(bookingProtection)
    .where(eq(bookingProtection.checkoutId, sale.id));
  if (!p || (!terminal(p.state) && !(p.state === "pending" && p.expiresAt <= now))) return false;
  if (!terminal(p.state)) {
    const [a] = await tx
      .select()
      .from(appointment)
      .where(eq(appointment.id, p.appointmentId))
      .for("update");
    if (a?.status === "booked") {
      await finishProtection(tx, a, "expired", now, null);
      const [updated] = await tx
        .update(appointment)
        .set({ status: "cancelled", version: sql`${appointment.version} + 1` })
        .where(eq(appointment.id, a.id))
        .returning();
      if (updated) await closeAppointment(tx, updated, now, { notify: false });
    }
  }
  return true;
}
