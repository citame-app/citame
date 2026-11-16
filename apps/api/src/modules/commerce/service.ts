import { createHash, randomBytes, randomInt } from "node:crypto";
import type { Checkout, CreateCheckoutInput, StartPaymentInput } from "@sob/contracts";
import { permissionsFor } from "@sob/contracts";
import {
  appointment,
  appointmentService,
  cashMovement,
  cashSession,
  checkout,
  checkoutLine,
  checkoutPayment,
  checkoutRefund,
  type Database,
  staffProfile,
} from "@sob/db";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { requirePermission } from "../../auth/policy";
import type { Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import type { PaymentGateway } from "../../payments/types";
import type { Tx } from "../../tx";
import { accrueCommissions } from "../accounting/service";
import {
  activateCheckoutGifts,
  pendingGiftForCheckout,
  redeemGift,
  syncCheckoutGiftRefunds,
  voidCheckoutGifts,
} from "../gift-cards/value";
import {
  consumeReservedInventory,
  loadCheckoutProducts,
  releaseCheckoutInventory,
  reserveCheckoutProducts,
} from "../inventory/reservations";
import {
  activateCheckoutPasses,
  membershipDiscounts,
  preparePassRefund,
  redeemPass,
  syncCheckoutPassRefunds,
  voidCheckoutPasses,
} from "../passes/value";
import { allocateDiscount } from "./money";

type Connection = Database | Tx;
const hash = (data: unknown) => createHash("sha256").update(JSON.stringify(data)).digest("hex");
const idemHash = ({ idempotencyKey: _, ...body }: Record<string, unknown>) => hash(body);
export function requireOperator(principal: Principal, refundAccess = false) {
  requirePermission(principal, refundAccess ? "refunds" : "commerce");
}

function checkReplay(row: { requestHash: string }, requestHash: string) {
  if (row.requestHash !== requestHash)
    throw new DomainError(
      "invalid_state",
      "Idempotency key already belongs to a different request",
    );
}
async function saleRow(db: Connection, id: string, principal: Principal, lock = false) {
  if (principal.role !== "client") requireOperator(principal);
  const query = db.select().from(checkout).where(eq(checkout.id, id));
  const [row] = await (lock ? query.for("update") : query);
  const restricted =
    principal.role === "staff" && !permissionsFor(principal.role, principal.accessPreset).allSales;
  const ownSale =
    row &&
    ((row.staffId !== null && row.staffId === principal.staffId) ||
      (row.staffId === null && row.createdBy === principal.userId));
  if (
    !row ||
    (principal.role === "client" && row.clientId !== principal.clientId) ||
    (restricted && !ownSale)
  )
    throw new DomainError("not_found", "Checkout not found");
  return row;
}
async function snapshot(db: Connection, row: typeof checkout.$inferSelect): Promise<Checkout> {
  const lines = await db
    .select()
    .from(checkoutLine)
    .where(eq(checkoutLine.checkoutId, row.id))
    .orderBy(checkoutLine.createdAt, checkoutLine.id);
  const payments = await db
    .select()
    .from(checkoutPayment)
    .where(eq(checkoutPayment.checkoutId, row.id))
    .orderBy(checkoutPayment.createdAt, checkoutPayment.id);
  const refunds = payments.length
    ? await db
        .select()
        .from(checkoutRefund)
        .where(
          and(
            inArray(
              checkoutRefund.paymentId,
              payments.map((p) => p.id),
            ),
          ),
        )
    : [];
  const paidCents = payments
    .filter((p) => p.status === "succeeded" || p.status === "reconciliation")
    .reduce((a, b) => a + b.amountCents, 0);
  const refundedCents = refunds
    .filter((refund) => refund.status === "succeeded")
    .reduce((a, b) => a + b.amountCents, 0);
  return {
    id: row.id,
    appointmentId: row.appointmentId,
    clientId: row.clientId,
    staffId: row.staffId,
    currency: "EUR",
    status: row.status,
    subtotalCents: row.subtotalCents,
    discountCents: row.discountCents,
    tipCents: row.tipCents,
    taxCents: row.taxCents,
    totalCents: row.totalCents,
    fulfilledAt: row.fulfilledAt?.toISOString() ?? null,
    paidCents,
    refundedCents,
    overpaidCents: Math.max(0, paidCents - refundedCents - row.totalCents),
    balanceCents: Math.max(0, row.totalCents - paidCents),
    lines: lines.map((line) => ({
      id: line.id,
      kind: line.kind,
      description: line.description,
      quantity: line.quantity,
      unitAmountCents: line.unitAmountCents,
      taxBasisPoints: line.taxBasisPoints,
      passPeriodId: line.passPeriodId,
      discountCents: line.discountCents,
    })),
    payments: payments.map((payment) => ({
      id: payment.id,
      method: payment.method,
      status: payment.status,
      amountCents: payment.amountCents,
      order: payment.bankOrder,
      createdAt: payment.createdAt.toISOString(),
      updatedAt: payment.updatedAt.toISOString(),
    })),
    refunds: refunds.map((refund) => ({
      id: refund.id,
      paymentId: refund.paymentId,
      amountCents: refund.amountCents,
      status: refund.status,
      reason: refund.reason,
      createdAt: refund.createdAt.toISOString(),
      updatedAt: refund.updatedAt.toISOString(),
    })),
    createdAt: row.createdAt.toISOString(),
  };
}
export async function getCheckout(db: Database, id: string, principal: Principal) {
  return db.transaction(async (tx) => snapshot(tx, await saleRow(tx, id, principal)), {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
}
export async function listCheckouts(db: Database, principal: Principal) {
  requireOperator(principal);
  return db.transaction(
    async (tx) => {
      const rows = await tx
        .select()
        .from(checkout)
        .where(
          permissionsFor(principal.role, principal.accessPreset).allSales
            ? undefined
            : sql`(${checkout.staffId} = ${principal.staffId} or (${checkout.staffId} is null and ${checkout.createdBy} = ${principal.userId}))`,
        )
        .orderBy(desc(checkout.createdAt), desc(checkout.id))
        .limit(100);
      const results: Checkout[] = [];
      for (const row of rows) results.push(await snapshot(tx, row));
      return results;
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
async function refreshStatus(tx: Tx, id: string) {
  const [row] = await tx.select().from(checkout).where(eq(checkout.id, id));
  if (!row || row.status === "void") return;
  if (await syncCheckoutPassRefunds(tx, id)) return;
  if (await syncCheckoutGiftRefunds(tx, id)) return;
  const view = await snapshot(tx, row);
  const status =
    view.refundedCents > 0
      ? view.paidCents - view.refundedCents >= view.totalCents
        ? "paid"
        : view.refundedCents >= view.paidCents
          ? "refunded"
          : "partially_refunded"
      : view.paidCents >= view.totalCents
        ? "paid"
        : "open";
  if (status === "paid" && !row.fulfilledAt) await fulfillCheckout(tx, id);
  await tx.update(checkout).set({ status }).where(eq(checkout.id, id));
}
async function fulfillCheckout(tx: Tx, id: string) {
  await consumeReservedInventory(tx, id);
  await accrueCommissions(tx, id);
  await activateCheckoutGifts(tx, id);
  await activateCheckoutPasses(tx, id);
  const fulfilledAt = new Date();
  await tx.update(checkout).set({ fulfilledAt }).where(eq(checkout.id, id));
  return fulfilledAt;
}
export async function voidCheckout(db: Database, id: string, principal: Principal) {
  return db.transaction(async (tx) => {
    const row = await saleRow(tx, id, principal, true);
    if (row.status === "void") return snapshot(tx, row);
    const payments = await tx
      .select()
      .from(checkoutPayment)
      .where(eq(checkoutPayment.checkoutId, id));
    if (row.status !== "open" || row.fulfilledAt || payments.some((p) => p.status !== "failed"))
      throw new DomainError(
        "invalid_state",
        "Only unpaid checkouts without unresolved payment attempts can be voided",
      );
    await releaseCheckoutInventory(tx, id);
    await voidCheckoutGifts(tx, id);
    await voidCheckoutPasses(tx, id);
    const [updated] = await tx
      .update(checkout)
      .set({ status: "void" })
      .where(eq(checkout.id, id))
      .returning();
    if (!updated) throw new Error("Checkout void failed");
    await recordAudit(tx, {
      actorUserId: principal.userId,
      action: "commerce.checkout_voided",
      entity: "checkout",
      entityId: id,
    });
    return snapshot(tx, updated);
  });
}
export async function createCheckout(
  db: Database,
  input: CreateCheckoutInput,
  principal: Principal,
) {
  return db.transaction((tx) => createCheckoutInTransaction(tx, input, principal));
}
export async function getCheckoutInTransaction(tx: Tx, id: string, principal: Principal) {
  return snapshot(tx, await saleRow(tx, id, principal));
}
export async function createCheckoutInTransaction(
  tx: Tx,
  input: CreateCheckoutInput,
  principal: Principal,
  options: { giftPurchase?: boolean } = {},
) {
  const giftPurchase =
    options.giftPurchase === true &&
    input.lines.length === 1 &&
    input.lines[0]?.kind === "gift_card" &&
    input.lines[0].quantity === 1 &&
    !input.appointmentId &&
    !input.staffId &&
    !input.discountCents &&
    !input.tipCents;
  if (input.lines.some((line) => line.kind === "gift_card") && !giftPurchase)
    throw new DomainError("forbidden", "Gift purchases must use the gift card purchase workflow");
  if (giftPurchase && principal.role === "client" && input.clientId !== principal.clientId)
    throw new DomainError("forbidden", "Gift buyer must match the authenticated client");
  if (
    principal.role === "client" &&
    !giftPurchase &&
    (!input.appointmentId || input.lines.length || input.discountCents || input.staffId)
  )
    throw new DomainError("forbidden", "Clients can check out only their own appointment");
  if (principal.role !== "client") requireOperator(principal);
  // Serialize repeated creates before looking up idempotency or the unique appointment.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`checkout:${input.appointmentId ?? `${principal.userId}:${input.idempotencyKey}`}`}, 0))`,
  );
  const requestHash = idemHash(input);
  const [existing] = await tx
    .select()
    .from(checkout)
    .where(
      and(
        eq(checkout.createdBy, principal.userId),
        eq(checkout.idempotencyKey, input.idempotencyKey),
      ),
    );
  if (existing) {
    checkReplay(existing, requestHash);
    return snapshot(tx, existing);
  }
  let clientId = input.clientId ?? null;
  let staffId = input.staffId ?? (principal.role === "staff" ? principal.staffId : null);
  if (
    principal.role === "staff" &&
    !permissionsFor(principal.role, principal.accessPreset).allSales &&
    input.staffId &&
    input.staffId !== principal.staffId
  )
    throw new DomainError("forbidden", "Staff can only attribute sales to themselves");
  if (staffId && !input.appointmentId) {
    const [seller] = await tx
      .select()
      .from(staffProfile)
      .where(
        and(
          eq(staffProfile.id, staffId),
          eq(staffProfile.active, true),
          isNull(staffProfile.deletedAt),
        ),
      );
    if (!seller) throw new DomainError("not_found", "Active staff member not found");
  }
  const lines: {
    kind: string;
    productId?: string;
    giftCardId?: string;
    unitCostCents?: number | null;
    serviceId?: string | null;
    membershipPeriodId?: string | null;
    description: string;
    quantity: number;
    unitAmountCents: number;
    taxBasisPoints: number;
    discountCents?: number;
    taxCents?: number;
  }[] = [];
  if (input.appointmentId) {
    const [booking] = await tx
      .select()
      .from(appointment)
      .where(eq(appointment.id, input.appointmentId))
      .for("update");
    if (
      !booking ||
      booking.deletedAt ||
      (principal.role === "client" && booking.clientId !== principal.clientId) ||
      (principal.role === "staff" &&
        !permissionsFor(principal.role, principal.accessPreset).allSales &&
        booking.staffId !== principal.staffId)
    )
      throw new DomainError("not_found", "Appointment not found");
    if (booking.status === "cancelled")
      throw new DomainError("invalid_state", "Cancelled appointments cannot be checked out");
    if (clientId && clientId !== booking.clientId)
      throw new DomainError("validation_error", "Checkout client must match appointment");
    clientId = booking.clientId;
    if (input.staffId && input.staffId !== booking.staffId)
      throw new DomainError(
        "validation_error",
        "Appointment seller must match the booked professional",
      );
    staffId = booking.staffId;
    const [previous] = await tx
      .select()
      .from(checkout)
      .where(
        and(eq(checkout.appointmentId, input.appointmentId), sql`${checkout.status} <> 'void'`),
      );
    if (previous) {
      if (input.lines.length || input.discountCents || input.tipCents || input.clientId)
        checkReplay(previous, requestHash);
      return snapshot(tx, previous);
    }
    const booked = await tx
      .select()
      .from(appointmentService)
      .where(eq(appointmentService.appointmentId, booking.id))
      .orderBy(asc(appointmentService.position));
    if (!booked.length || booked.some((s) => s.currency !== input.currency))
      throw new DomainError(
        "validation_error",
        "Appointment currency must match the EUR merchant currency",
      );
    lines.push(
      ...booked.map((s) => ({
        kind: "service",
        serviceId: s.serviceId,
        description: s.name,
        quantity: 1,
        unitAmountCents: s.priceCents,
        taxBasisPoints: 0,
      })),
    );
  }
  const products = await loadCheckoutProducts(tx, input.lines);
  for (const line of input.lines) {
    if (line.kind === "gift_card") {
      const card = await pendingGiftForCheckout(tx, line.giftCardId ?? "", principal);
      lines.push({
        kind: "gift_card",
        giftCardId: card.id,
        description: card.label || "Gift card",
        quantity: 1,
        unitAmountCents: card.amountCents,
        taxBasisPoints: 0,
      });
      continue;
    }
    if (line.kind === "product") {
      const product = line.productId ? products.get(line.productId) : undefined;
      if (!product) throw new DomainError("not_found", "Product not found");
      lines.push({
        kind: "product",
        productId: product.id,
        description: product.name,
        quantity: line.quantity,
        unitAmountCents: product.priceCents,
        unitCostCents: product.costCents,
        taxBasisPoints: product.taxBasisPoints,
      });
      continue;
    }
    if (line.unitAmountCents === undefined || !line.description)
      throw new DomainError("validation_error", "Custom items need a description and amount");
    lines.push({
      kind: "custom",
      description: line.description,
      quantity: line.quantity,
      unitAmountCents: line.unitAmountCents,
      taxBasisPoints: line.taxBasisPoints,
    });
  }
  const subtotalCents = lines.reduce((a, b) => a + b.quantity * b.unitAmountCents, 0);
  const manualDiscounts = allocateDiscount(
    lines.map((line) => line.quantity * line.unitAmountCents),
    Math.min(input.discountCents, subtotalCents),
  );
  const memberDiscounts = await membershipDiscounts(tx, clientId, input.appointmentId, lines);
  const effectiveDiscounts = lines.map((_, index) =>
    Math.max(manualDiscounts[index] ?? 0, memberDiscounts[index]?.amountCents ?? 0),
  );
  const discountCents = effectiveDiscounts.reduce((sum, n) => sum + n, 0);
  const totalCents = subtotalCents - discountCents + input.tipCents;
  if (
    !lines.length ||
    subtotalCents > 2147483647 ||
    input.discountCents > subtotalCents ||
    !Number.isSafeInteger(totalCents) ||
    totalCents < 0 ||
    totalCents > 999999999
  )
    throw new DomainError("validation_error", "Invalid checkout total or discount");
  // Prices include tax. Discounts are allocated proportionally in integer cents.
  const discounts = effectiveDiscounts;
  let taxCents = 0;
  for (const [index, line] of lines.entries()) {
    const gross = line.quantity * line.unitAmountCents;
    const discount = discounts[index] ?? 0;
    line.discountCents = discount;
    if (
      (memberDiscounts[index]?.amountCents ?? 0) > 0 &&
      discount === memberDiscounts[index]?.amountCents
    )
      line.membershipPeriodId = memberDiscounts[index]?.periodId ?? null;
    line.taxCents = Math.round(
      ((gross - discount) * line.taxBasisPoints) / (10000 + line.taxBasisPoints),
    );
    taxCents += line.taxCents;
  }
  const [row] = await tx
    .insert(checkout)
    .values({
      appointmentId: input.appointmentId,
      clientId,
      staffId,
      subtotalCents,
      discountCents,
      tipCents: input.tipCents,
      taxCents,
      totalCents,
      status: totalCents === 0 ? "paid" : "open",
      createdBy: principal.userId,
      idempotencyKey: input.idempotencyKey,
      requestHash,
    })
    .returning();
  if (!row) throw new Error("Checkout insert failed");
  const insertedLines = await tx
    .insert(checkoutLine)
    .values(lines.map((line) => ({ ...line, checkoutId: row.id })))
    .returning();
  await reserveCheckoutProducts(tx, row.id, insertedLines);
  if (totalCents === 0) row.fulfilledAt = await fulfillCheckout(tx, row.id);
  await recordAudit(tx, {
    actorUserId: principal.userId,
    action: "commerce.checkout_created",
    entity: "checkout",
    entityId: row.id,
    metadata: { totalCents, currency: row.currency },
  });
  return snapshot(tx, row);
}
async function openSession(tx: Tx) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('sob.cash-session', 0))`);
  const [session] = await tx
    .select()
    .from(cashSession)
    .where(isNull(cashSession.closedAt))
    .for("update");
  if (!session)
    throw new DomainError(
      "invalid_state",
      "Open the cash register before recording cash movements",
    );
  return session;
}
export async function startPayment(
  db: Database,
  id: string,
  input: StartPaymentInput,
  principal: Principal,
  gateway: PaymentGateway | null,
  bizumEnabled = false,
) {
  if (
    principal.role === "client" &&
    !["redsys_card", "redsys_bizum", "gift_card", "package", "membership"].includes(input.method)
  )
    throw new DomainError("forbidden", "Clients cannot record manual payments");
  const bank = input.method === "redsys_card" || input.method === "redsys_bizum";
  if (bank && (!gateway || (input.method === "redsys_bizum" && !bizumEnabled)))
    throw new DomainError("payment_unavailable", "This online payment method is not configured");
  return db.transaction(async (tx) => {
    const sale = await saleRow(tx, id, principal, true);
    const requestHash = idemHash(input);
    const [previous] = await tx
      .select()
      .from(checkoutPayment)
      .where(
        and(
          eq(checkoutPayment.checkoutId, id),
          eq(checkoutPayment.idempotencyKey, input.idempotencyKey),
        ),
      );
    let payment = previous;
    if (previous) checkReplay(previous, requestHash);
    else {
      const view = await snapshot(tx, sale);
      if (
        sale.status !== "open" ||
        input.amountCents > view.balanceCents ||
        view.payments.some((p) => p.status === "pending" || p.status === "reconciliation")
      )
        throw new DomainError(
          "invalid_state",
          "Payment exceeds the balance or another payment is unresolved",
        );
      const session = input.method === "cash" ? await openSession(tx) : null;
      if (session && (await cashView(tx, session)).expectedCents + input.amountCents > 999999999)
        throw new DomainError(
          "invalid_state",
          "The register balance exceeds its supported cash limit",
        );
      for (let attempt = 0; attempt < 3; attempt++) {
        const order = bank ? `${randomInt(1000, 10000)}${randomBytes(4).toString("hex")}` : null;
        [payment] = await tx
          .insert(checkoutPayment)
          .values({
            checkoutId: id,
            method: input.method,
            amountCents: input.amountCents,
            status: bank ? "pending" : "succeeded",
            bankOrder: order,
            idempotencyKey: input.idempotencyKey,
            requestHash,
            createdBy: principal.userId,
            cashSessionId: session?.id,
          })
          .onConflictDoNothing()
          .returning();
        if (payment) break;
      }
      if (!payment)
        throw new DomainError("invalid_state", "Could not allocate a unique payment order");
      if (input.method === "package" || input.method === "membership")
        await redeemPass(tx, input, payment.id, id, principal);
      if (input.method === "gift_card")
        await redeemGift(
          tx,
          input.giftCardCode ?? "",
          input.amountCents,
          payment.id,
          id,
          principal,
        );
      if (session)
        await tx.insert(cashMovement).values({
          sessionId: session.id,
          paymentId: payment.id,
          amountCents: payment.amountCents,
          kind: "sale",
          reason: "Checkout payment",
          idempotencyKey: `payment-${payment.id}`,
          requestHash,
          createdBy: principal.userId,
        });
      await refreshStatus(tx, id);
      await recordAudit(tx, {
        actorUserId: principal.userId,
        action: "commerce.payment_started",
        entity: "checkout_payment",
        entityId: payment.id,
        metadata: {
          amountCents: payment.amountCents,
          method: payment.method,
          status: payment.status,
        },
      });
    }
    if (!payment) throw new Error("Missing payment after transaction");
    const form =
      bank && payment.bankOrder && payment.status === "pending"
        ? gateway?.checkout({
            order: payment.bankOrder,
            amountCents: payment.amountCents,
            currency: payment.currency,
            method: payment.method === "redsys_bizum" ? "bizum" : "card",
          })
        : undefined;
    return {
      payment: {
        id: payment.id,
        order: payment.bankOrder,
        amountCents: payment.amountCents,
        method: payment.method,
        status: payment.status,
      },
      form: form ?? null,
    };
  });
}
export async function receiveBankNotification(
  db: Database,
  gateway: PaymentGateway,
  fields: Record<string, unknown>,
) {
  const bank = gateway.verify(fields);
  return db.transaction(async (tx) => {
    const [found] = await tx
      .select()
      .from(checkoutPayment)
      .where(eq(checkoutPayment.bankOrder, bank.order));
    if (!found) throw new DomainError("validation_error", "Unknown bank order");
    const [sale] = await tx
      .select()
      .from(checkout)
      .where(eq(checkout.id, found.checkoutId))
      .for("update");
    const [payment] = await tx
      .select()
      .from(checkoutPayment)
      .where(eq(checkoutPayment.id, found.id))
      .for("update");
    if (
      !sale ||
      !payment ||
      payment.amountCents !== bank.amountCents ||
      payment.currency !== bank.currency
    )
      throw new DomainError("validation_error", "Bank amount or currency mismatch");
    if (
      payment.status === "succeeded" ||
      payment.status === "reconciliation" ||
      (payment.status === "failed" && !bank.success && payment.bankResponse === bank.responseCode)
    )
      return;
    const view = await snapshot(tx, sale);
    const status = bank.success
      ? sale.status === "void" || bank.amountCents > view.balanceCents
        ? "reconciliation"
        : "succeeded"
      : "failed";
    await tx
      .update(checkoutPayment)
      .set({ status, bankResponse: bank.responseCode, authorizationCode: bank.authorizationCode })
      .where(eq(checkoutPayment.id, payment.id));
    await refreshStatus(tx, sale.id);
    await recordAudit(tx, {
      actorUserId: null,
      action: "commerce.payment_settled",
      entity: "checkout_payment",
      entityId: payment.id,
      metadata: { status, responseCode: bank.responseCode, amountCents: bank.amountCents },
    });
  });
}
export async function manualRefund(
  db: Database,
  paymentId: string,
  input: { amountCents: number; reason: string; idempotencyKey: string },
  principal: Principal,
) {
  requireOperator(principal, true);
  return db.transaction(async (tx) => {
    const [initial] = await tx
      .select()
      .from(checkoutPayment)
      .where(eq(checkoutPayment.id, paymentId));
    if (!initial) throw new DomainError("not_found", "Payment not found");
    await tx.select().from(checkout).where(eq(checkout.id, initial.checkoutId)).for("update");
    const [payment] = await tx
      .select()
      .from(checkoutPayment)
      .where(eq(checkoutPayment.id, paymentId))
      .for("update");
    if (!payment || !["succeeded", "reconciliation"].includes(payment.status))
      throw new DomainError("invalid_state", "Only captured payments can be refunded");
    const requestHash = idemHash(input);
    const [previous] = await tx
      .select()
      .from(checkoutRefund)
      .where(
        and(
          eq(checkoutRefund.paymentId, payment.id),
          eq(checkoutRefund.idempotencyKey, input.idempotencyKey),
        ),
      );
    if (previous) {
      checkReplay(previous, requestHash);
      return previous;
    }
    const refunds = await tx
      .select()
      .from(checkoutRefund)
      .where(
        and(
          eq(checkoutRefund.paymentId, payment.id),
          inArray(checkoutRefund.status, [
            "requested",
            "dispatched",
            "succeeded",
            "reconciliation",
          ]),
        ),
      );
    if (refunds.reduce((a, b) => a + b.amountCents, 0) + input.amountCents > payment.amountCents)
      throw new DomainError("invalid_state", "Refund exceeds the captured amount");
    const bank = payment.method.startsWith("redsys_");
    const session = payment.method === "cash" ? await openSession(tx) : null;
    if (session && (await cashView(tx, session)).expectedCents < input.amountCents)
      throw new DomainError(
        "invalid_state",
        "The register does not contain enough cash for this refund",
      );
    const [refund] = await tx
      .insert(checkoutRefund)
      .values({
        paymentId,
        amountCents: input.amountCents,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        createdBy: principal.userId,
        status: bank ? "requested" : "succeeded",
      })
      .returning();
    if (!refund) throw new Error("Refund insert failed");
    await preparePassRefund(tx, refund, payment);
    if (session)
      await tx.insert(cashMovement).values({
        sessionId: session.id,
        refundId: refund.id,
        amountCents: -input.amountCents,
        kind: "refund",
        reason: input.reason,
        idempotencyKey: `refund-${refund.id}`,
        requestHash,
        createdBy: principal.userId,
      });
    await refreshStatus(tx, payment.checkoutId);
    await recordAudit(tx, {
      actorUserId: principal.userId,
      action: "commerce.refund_requested",
      entity: "checkout_refund",
      entityId: refund.id,
      metadata: { status: refund.status, amountCents: refund.amountCents, paymentId },
    });
    return refund;
  });
}
async function cashView(tx: Connection, row: typeof cashSession.$inferSelect) {
  const movements = await tx
    .select()
    .from(cashMovement)
    .where(eq(cashMovement.sessionId, row.id))
    .orderBy(cashMovement.createdAt, cashMovement.id);
  const expectedCents =
    row.expectedCents ?? row.openingCents + movements.reduce((a, b) => a + b.amountCents, 0);
  return {
    ...row,
    expectedCents,
    differenceCents: row.countedCents === null ? null : row.countedCents - expectedCents,
    movements,
  };
}
export async function currentCashSession(db: Database, principal: Principal) {
  requirePermission(principal, "manageCash");
  return db.transaction(
    async (tx) => {
      const [row] = await tx
        .select()
        .from(cashSession)
        .orderBy(desc(cashSession.openedAt))
        .limit(1);
      return row ? cashView(tx, row) : null;
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
export async function openCashSession(db: Database, openingCents: number, principal: Principal) {
  requirePermission(principal, "manageCash");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('sob.cash-session', 0))`);
    if ((await tx.select().from(cashSession).where(isNull(cashSession.closedAt))).length)
      throw new DomainError("invalid_state", "The cash register is already open");
    const [row] = await tx
      .insert(cashSession)
      .values({ openingCents, openedBy: principal.userId })
      .returning();
    if (!row) throw new Error("Cash session insert failed");
    await recordAudit(tx, {
      actorUserId: principal.userId,
      action: "commerce.cash_opened",
      entity: "cash_session",
      entityId: row.id,
      metadata: { openingCents },
    });
    return cashView(tx, row);
  });
}
export async function closeCashSession(
  db: Database,
  id: string,
  countedCents: number,
  principal: Principal,
) {
  requirePermission(principal, "manageCash");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('sob.cash-session', 0))`);
    const [row] = await tx.select().from(cashSession).where(eq(cashSession.id, id)).for("update");
    if (!row) throw new DomainError("not_found", "Cash session not found");
    if (row.closedAt) {
      if (row.countedCents !== countedCents)
        throw new DomainError("invalid_state", "A closed cash count cannot be changed");
      return cashView(tx, row);
    }
    const view = await cashView(tx, row);
    const [closed] = await tx
      .update(cashSession)
      .set({
        closedAt: new Date(),
        closedBy: principal.userId,
        countedCents,
        expectedCents: view.expectedCents,
      })
      .where(eq(cashSession.id, id))
      .returning();
    if (!closed) throw new Error("Cash session update failed");
    await recordAudit(tx, {
      actorUserId: principal.userId,
      action: "commerce.cash_closed",
      entity: "cash_session",
      entityId: id,
      metadata: { expectedCents: view.expectedCents, countedCents },
    });
    return cashView(tx, closed);
  });
}
export async function adjustCash(
  db: Database,
  input: {
    kind: "deposit" | "withdrawal";
    amountCents: number;
    reason: string;
    idempotencyKey: string;
  },
  principal: Principal,
) {
  requirePermission(principal, "manageCash");
  return db.transaction(async (tx) => {
    const session = await openSession(tx);
    const requestHash = idemHash(input);
    const [previous] = await tx
      .select()
      .from(cashMovement)
      .where(
        and(
          eq(cashMovement.sessionId, session.id),
          eq(cashMovement.idempotencyKey, input.idempotencyKey),
        ),
      );
    if (previous) {
      checkReplay(previous, requestHash);
      return cashView(tx, session);
    }
    const expected = (await cashView(tx, session)).expectedCents;
    const next = expected + (input.kind === "withdrawal" ? -input.amountCents : input.amountCents);
    if (next < 0 || next > 999999999)
      throw new DomainError(
        "invalid_state",
        "Cash movement exceeds the available register balance or limit",
      );
    await recordAudit(tx, {
      actorUserId: principal.userId,
      action: "commerce.cash_adjusted",
      entity: "cash_session",
      entityId: session.id,
      metadata: { kind: input.kind, amountCents: input.amountCents },
    });
    await tx.insert(cashMovement).values({
      sessionId: session.id,
      amountCents: input.amountCents * (input.kind === "withdrawal" ? -1 : 1),
      kind: input.kind,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      createdBy: principal.userId,
    });
    return cashView(tx, session);
  });
}

/** Reserve before contacting the bank; a crashed or ambiguous dispatch is never retried blindly. */
export async function executeRefund(
  db: Database,
  id: string,
  principal: Principal,
  gateway: PaymentGateway | null,
) {
  requireOperator(principal, true);
  if (!gateway) throw new DomainError("payment_unavailable", "Online refunds are not configured");
  const work = await db.transaction(async (tx) => {
    const [initial] = await tx
      .select({ paymentId: checkoutRefund.paymentId })
      .from(checkoutRefund)
      .where(eq(checkoutRefund.id, id));
    if (!initial) throw new DomainError("not_found", "Refund not found");
    const [payment] = await tx
      .select()
      .from(checkoutPayment)
      .where(eq(checkoutPayment.id, initial.paymentId));
    if (!payment) throw new DomainError("not_found", "Payment not found");
    await tx.select().from(checkout).where(eq(checkout.id, payment.checkoutId)).for("update");
    const [refund] = await tx
      .select()
      .from(checkoutRefund)
      .where(eq(checkoutRefund.id, id))
      .for("update");
    if (!refund) throw new DomainError("not_found", "Refund not found");
    if (refund.status !== "requested") return { refund, payment, dispatch: false };
    if (!payment.bankOrder || !["succeeded", "reconciliation"].includes(payment.status))
      throw new DomainError("invalid_state", "Only bank captures can be dispatched for refund");
    const [dispatched] = await tx
      .update(checkoutRefund)
      .set({ status: "dispatched" })
      .where(eq(checkoutRefund.id, id))
      .returning();
    if (!dispatched) throw new Error("Refund dispatch update failed");
    await recordAudit(tx, {
      actorUserId: principal.userId,
      action: "commerce.refund_dispatched",
      entity: "checkout_refund",
      entityId: id,
      metadata: { amountCents: refund.amountCents },
    });
    return { refund: dispatched, payment, dispatch: true };
  });
  if (!work.dispatch) return work.refund;
  let status: "succeeded" | "failed" | "reconciliation" = "reconciliation";
  try {
    const result = await gateway.refund({
      order: work.payment.bankOrder ?? "",
      amountCents: work.refund.amountCents,
      currency: work.payment.currency,
      refundId: id,
    });
    status = result.success ? "succeeded" : "failed";
  } catch {
    /* A lost bank response must stay reserved until reconciled. */
  }
  return db.transaction(async (tx) => {
    await tx.select().from(checkout).where(eq(checkout.id, work.payment.checkoutId)).for("update");
    const [row] = await tx
      .select()
      .from(checkoutRefund)
      .where(eq(checkoutRefund.id, id))
      .for("update");
    if (!row) throw new DomainError("not_found", "Refund not found");
    if (row.status !== "dispatched") return row;
    const [updated] = await tx
      .update(checkoutRefund)
      .set({ status })
      .where(eq(checkoutRefund.id, id))
      .returning();
    await refreshStatus(tx, work.payment.checkoutId);
    await recordAudit(tx, {
      actorUserId: principal.userId,
      action: "commerce.refund_result",
      entity: "checkout_refund",
      entityId: id,
      metadata: { status },
    });
    return updated;
  });
}
export async function reconcileRefund(
  db: Database,
  id: string,
  input: { outcome: "succeeded" | "failed"; reference: string },
  principal: Principal,
) {
  requireOperator(principal, true);
  return db.transaction(async (tx) => {
    const [initial] = await tx.select().from(checkoutRefund).where(eq(checkoutRefund.id, id));
    if (!initial) throw new DomainError("not_found", "Refund not found");
    const [payment] = await tx
      .select()
      .from(checkoutPayment)
      .where(eq(checkoutPayment.id, initial.paymentId));
    if (!payment) throw new DomainError("not_found", "Payment not found");
    await tx.select().from(checkout).where(eq(checkout.id, payment.checkoutId)).for("update");
    const [refund] = await tx
      .select()
      .from(checkoutRefund)
      .where(eq(checkoutRefund.id, id))
      .for("update");
    if (!refund) throw new DomainError("not_found", "Refund not found");
    if (refund.status === "dispatched" && Date.now() - refund.updatedAt.getTime() < 60000)
      throw new DomainError("invalid_state", "The bank refund is still in flight");
    if (!["dispatched", "reconciliation"].includes(refund.status))
      throw new DomainError("invalid_state", "Only ambiguous bank refunds can be reconciled");
    const [updated] = await tx
      .update(checkoutRefund)
      .set({ status: input.outcome })
      .where(eq(checkoutRefund.id, id))
      .returning();
    await refreshStatus(tx, payment.checkoutId);
    await recordAudit(tx, {
      actorUserId: principal.userId,
      action: "commerce.refund_reconciled",
      entity: "checkout_refund",
      entityId: id,
      metadata: { outcome: input.outcome, reference: input.reference },
    });
    return updated;
  });
}

/** A pending hosted attempt can be resolved only by an owner with a bank-portal reference. */
export async function reconcilePayment(
  db: Database,
  id: string,
  input: { outcome: "succeeded" | "failed"; reference: string },
  principal: Principal,
) {
  requireOperator(principal, true);
  return db.transaction(async (tx) => {
    const [initial] = await tx.select().from(checkoutPayment).where(eq(checkoutPayment.id, id));
    if (!initial) throw new DomainError("not_found", "Payment not found");
    const [sale] = await tx
      .select()
      .from(checkout)
      .where(eq(checkout.id, initial.checkoutId))
      .for("update");
    const [payment] = await tx
      .select()
      .from(checkoutPayment)
      .where(eq(checkoutPayment.id, id))
      .for("update");
    if (!sale || !payment) throw new DomainError("not_found", "Payment not found");
    if (payment.status !== "pending" || Date.now() - payment.updatedAt.getTime() < 60000)
      throw new DomainError(
        "invalid_state",
        "Only a pending bank payment outside its initial processing window can be reconciled",
      );
    const view = await snapshot(tx, sale);
    const status =
      input.outcome === "failed"
        ? "failed"
        : sale.status === "void" || payment.amountCents > view.balanceCents
          ? "reconciliation"
          : "succeeded";
    const [updated] = await tx
      .update(checkoutPayment)
      .set({ status })
      .where(eq(checkoutPayment.id, id))
      .returning();
    await refreshStatus(tx, sale.id);
    await recordAudit(tx, {
      actorUserId: principal.userId,
      action: "commerce.payment_reconciled",
      entity: "checkout_payment",
      entityId: id,
      metadata: { outcome: input.outcome, reference: input.reference },
    });
    return updated;
  });
}
