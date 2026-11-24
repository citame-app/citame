import { createHash } from "node:crypto";
import {
  type Checkout,
  createCheckoutSchema,
  type VisitCheckout,
  type VisitPayment,
  type VisitPaymentInput,
} from "@sob/contracts";
import {
  appointment,
  appointmentVisitPart,
  checkout,
  checkoutPayment,
  type Database,
  visitPayment,
} from "@sob/db";
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { canReviewVisitCheckouts } from "../../auth/policy";
import type { Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import { lockScheduling, type Tx } from "../../tx";
import { appointmentBillingHolds, externallySettledAppointments } from "./appointment-billing";
import {
  createCheckoutInTransaction,
  readAppointmentCheckout,
  requireOperator,
  saleRow,
  startPaymentInTransaction,
} from "./service";

type VisitGroup = Pick<VisitCheckout, "groupId" | "source"> & {
  bookings: (typeof appointment.$inferSelect)[];
};
type VisitReviewContext = { now: Date; generation: string };
const digest = (input: unknown) => createHash("sha256").update(JSON.stringify(input)).digest("hex");

async function loadVisitGroup(
  tx: Tx,
  appointmentId: string,
  principal: Principal,
): Promise<VisitGroup> {
  const [anchor] = await tx
    .select({ booking: appointment, itineraryId: appointmentVisitPart.visitId })
    .from(appointment)
    .leftJoin(appointmentVisitPart, eq(appointmentVisitPart.appointmentId, appointment.id))
    .where(and(eq(appointment.id, appointmentId), isNull(appointment.deletedAt)));
  const groupId = anchor?.itineraryId ?? anchor?.booking.visitGroupId;
  if (!anchor || !groupId || !canReviewVisitCheckouts(principal, [anchor.booking.staffId]))
    throw new DomainError("not_found", "Visit not found");

  const rows = anchor.itineraryId
    ? await tx
        .select({ booking: appointment })
        .from(appointmentVisitPart)
        .innerJoin(appointment, eq(appointment.id, appointmentVisitPart.appointmentId))
        .where(and(eq(appointmentVisitPart.visitId, groupId), isNull(appointment.deletedAt)))
        .orderBy(asc(appointmentVisitPart.position))
    : await tx
        .select({ booking: appointment })
        .from(appointment)
        .where(and(eq(appointment.visitGroupId, groupId), isNull(appointment.deletedAt)))
        .orderBy(asc(appointment.startsAt), asc(appointment.id));
  const bookings = rows.map(({ booking }) => booking);
  if (
    bookings.some((booking) => booking.clientId !== anchor.booking.clientId) ||
    !canReviewVisitCheckouts(
      principal,
      bookings.map(({ staffId }) => staffId),
    )
  )
    throw new DomainError("not_found", "Visit not found");
  if (bookings.length < 2)
    throw new DomainError("invalid_state", "Visit requires at least two appointments");
  return { groupId, source: anchor.itineraryId ? "itinerary" : "import", bookings };
}

function visitAllocations(visit: Omit<VisitCheckout, "paymentReview">) {
  const allocations: { receiptId: string; amountCents: number }[] = [];
  for (const part of visit.appointments) {
    if (part.status === "cancelled" || part.settledExternally) continue;
    const { receipt } = part;
    if (
      !receipt ||
      receipt.payments.some(({ status }) => status === "pending" || status === "reconciliation") ||
      (receipt.lines.some(({ pricePending }) => pricePending) &&
        receipt.protection?.state !== "pending")
    )
      return [];
    const amountCents = receipt.payableCents ?? receipt.balanceCents;
    if (receipt.status === "open" && amountCents > 0)
      allocations.push({ receiptId: receipt.id, amountCents });
  }
  return allocations;
}

async function visitReview(
  tx: Tx,
  { groupId, source, bookings }: VisitGroup,
  principal: Principal,
  context: VisitReviewContext,
  receiptFor: (id: string, billable: boolean) => Promise<Checkout | null>,
) {
  const settled = await externallySettledAppointments(
    tx,
    bookings.map(({ id }) => id),
  );
  const billableIds = new Set(
    bookings.flatMap(({ id, status }) => (status === "cancelled" || settled.has(id) ? [] : [id])),
  );
  if ((await appointmentBillingHolds(tx, [...billableIds])).size)
    throw new DomainError(
      "invalid_state",
      "Review the imported charges before preparing this visit",
    );

  const appointments: VisitCheckout["appointments"] = [];
  for (const booking of bookings) {
    appointments.push({
      appointmentId: booking.id,
      staffId: booking.staffId,
      startsAt: booking.startsAt.toISOString(),
      status: booking.status,
      settledExternally: settled.has(booking.id),
      receipt: await receiptFor(booking.id, billableIds.has(booking.id)),
    });
  }
  const visit = { groupId, source, appointments };
  const allocations = visitAllocations(visit);
  const totalCents = allocations.reduce((sum, line) => sum + line.amountCents, 0);
  const paymentReview =
    totalCents > 0
      ? {
          totalCents,
          token: digest([
            context.generation,
            principal.userId,
            groupId,
            source,
            bookings.map(({ id, version, staffId }) => [id, version, staffId]),
            appointments.map(({ receipt }) => receipt),
          ]),
        }
      : null;
  return { visit: { ...visit, paymentReview }, allocations };
}

export async function prepareVisitCheckouts(
  db: Database,
  appointmentId: string,
  principal: Principal,
  context: VisitReviewContext,
): Promise<VisitCheckout> {
  requireOperator(principal);
  return db.transaction(async (tx) => {
    // Creation follows the individual checkout order and never locks an existing receipt.
    await lockScheduling(tx);
    const group = await loadVisitGroup(tx, appointmentId, principal);
    const { visit } = await visitReview(tx, group, principal, context, (id, billable) =>
      billable
        ? createCheckoutInTransaction(
            tx,
            createCheckoutSchema.parse({ appointmentId: id, idempotencyKey: crypto.randomUUID() }),
            principal,
            { now: context.now },
          )
        : readAppointmentCheckout(tx, id, principal, context.now),
    );
    return visit;
  });
}

function reviewChanged() {
  return new DomainError(
    "version_conflict",
    "Review the current visit and its balances before recording payment",
  );
}

async function recordedVisitPayment(
  tx: Tx,
  operation: { id: string; method: VisitPaymentInput["method"] },
  principal: Principal,
  bookingIds: Set<string>,
): Promise<VisitPayment> {
  const allocations = await tx
    .select({
      paymentId: checkoutPayment.id,
      receiptId: checkoutPayment.checkoutId,
      amountCents: checkoutPayment.amountCents,
    })
    .from(checkoutPayment)
    .where(eq(checkoutPayment.visitPaymentId, operation.id))
    .orderBy(asc(checkoutPayment.checkoutId));
  if (allocations.length === 0) throw new Error("Visit payment is missing its allocations");
  for (const allocation of allocations) {
    const { appointmentId } = await saleRow(tx, allocation.receiptId, principal);
    if (!appointmentId || !bookingIds.has(appointmentId))
      throw new DomainError("not_found", "Visit payment not found");
  }
  return {
    ...operation,
    totalCents: allocations.reduce((sum, line) => sum + line.amountCents, 0),
    allocations,
  };
}

export async function collectVisitPayment(
  db: Database,
  appointmentId: string,
  input: VisitPaymentInput,
  principal: Principal,
  context: VisitReviewContext,
): Promise<VisitPayment> {
  requireOperator(principal);
  return db.transaction(async (tx) => {
    const requestLock = `visit-payment:${principal.userId}:${input.idempotencyKey}`;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${requestLock}, 0))`);
    const initial = await loadVisitGroup(tx, appointmentId, principal);
    const initialIds = initial.bookings.map(({ id }) => id);
    // Individual payments and refunds lock their receipt before scheduling. Lock every
    // active receipt in a stable order before taking scheduling for the group.
    const locked = await tx
      .select()
      .from(checkout)
      .where(and(inArray(checkout.appointmentId, initialIds), ne(checkout.status, "void")))
      .orderBy(asc(checkout.id))
      .for("update");
    await lockScheduling(tx);
    const group = await loadVisitGroup(tx, appointmentId, principal);
    const bookingIds = new Set(group.bookings.map(({ id }) => id));
    const requestHash = digest([group.groupId, group.source, input.method, input.reviewToken]);
    const [previous] = await tx
      .select()
      .from(visitPayment)
      .where(
        and(
          eq(visitPayment.actorUserId, principal.userId),
          eq(visitPayment.idempotencyKey, input.idempotencyKey),
        ),
      );
    if (previous) {
      if (previous.requestHash !== requestHash)
        throw new DomainError(
          "invalid_state",
          "Idempotency key already belongs to a different request",
        );
      return recordedVisitPayment(
        tx,
        { id: previous.id, method: input.method },
        principal,
        bookingIds,
      );
    }

    const { visit, allocations } = await visitReview(tx, group, principal, context, (id) =>
      readAppointmentCheckout(tx, id, principal, context.now),
    );
    if (visit.paymentReview?.token !== input.reviewToken) throw reviewChanged();
    const lockedById = new Map(locked.map((row) => [row.id, row]));
    const [operation] = await tx
      .insert(visitPayment)
      .values({
        actorUserId: principal.userId,
        groupId: group.groupId,
        groupSource: group.source,
        method: input.method,
        idempotencyKey: input.idempotencyKey,
        requestHash,
      })
      .returning({ id: visitPayment.id });
    if (!operation) throw new Error("Could not create visit payment");
    for (const { receiptId, amountCents } of allocations) {
      const sale = lockedById.get(receiptId);
      if (!sale) throw reviewChanged();
      await startPaymentInTransaction(
        tx,
        sale,
        { method: input.method, amountCents, idempotencyKey: `visit-${operation.id}` },
        principal,
        { now: context.now, visitPaymentId: operation.id },
      );
    }
    return recordedVisitPayment(
      tx,
      { id: operation.id, method: input.method },
      principal,
      bookingIds,
    );
  });
}
