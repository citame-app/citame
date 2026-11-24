import {
  type BillingReviewReason,
  type ExternalBalance,
  externalBalanceSchema,
  type ImportedPriceReview,
  type ImportedPriceReviewPreview,
  type ImportedSettlement,
  type ImportedUnpaidReview,
  moneyCentsSchema,
  recordedImportedSettlementSchema,
} from "@sob/contracts";
import {
  appointment,
  appointmentContext,
  appointmentService,
  auditLog,
  bookingProtection,
  checkout,
  type Database,
} from "@sob/db";
import { and, asc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { requireRole } from "../../auth/policy";
import type { Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import { lockScheduling } from "../../tx";

export const importedPriceReviewAudit = "commerce.imported_price_reviewed";
const importedSettlementAudit = "commerce.imported_settlement_recorded";
const importedPartialAudit = "commerce.imported_partial_payment_recorded";
const importedUnpaidAudit = "commerce.imported_unpaid_confirmed";
const sourceBilling = and(
  eq(appointmentContext.source, "booksy"),
  or(eq(appointmentContext.paid, true), eq(appointmentContext.invoiced, true)),
);

/** Older clients accept only the original hold reasons and must still disable collection. */
export function compatibleBillingReasons(
  reasons: BillingReviewReason[],
  supportsUnknownPayment: boolean,
): BillingReviewReason[] {
  return supportsUnknownPayment || !reasons.includes("unknown_booksy_payment")
    ? reasons
    : [
        ...new Set(
          reasons.map((reason) =>
            reason === "unknown_booksy_payment" ? "unknown_amount" : reason,
          ),
        ),
      ];
}

async function unknownBooksyPayments(db: Pick<Database, "select">, ids: string[]) {
  const rows = await db
    .select({
      id: appointmentContext.appointmentId,
      lineId: appointmentContext.id,
      version: appointmentContext.billingVersion,
    })
    .from(appointmentContext)
    .where(
      and(
        inArray(appointmentContext.appointmentId, ids),
        eq(appointmentContext.source, "booksy"),
        or(isNull(appointmentContext.paid), eq(appointmentContext.sourcePaymentUnverified, true)),
      ),
    )
    .orderBy(asc(appointmentContext.id));
  const snapshots = new Map<string, string[]>();
  for (const row of rows) {
    const lines = snapshots.get(row.id) ?? [];
    lines.push(`${row.lineId}:${row.version}`);
    snapshots.set(row.id, lines);
  }
  return snapshots;
}

async function importedUnpaidReviews(db: Pick<Database, "select">, ids: string[]) {
  return db
    .select({ id: auditLog.entityId, metadata: auditLog.metadata })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entity, "appointment"),
        inArray(auditLog.entityId, ids),
        eq(auditLog.action, importedUnpaidAudit),
      ),
    );
}

export async function booksyPaymentReviews(db: Pick<Database, "select">, ids: string[]) {
  const unknown = await unknownBooksyPayments(db, ids);
  const states = new Map<string, "pending" | "confirmed_unpaid">();
  for (const id of unknown.keys()) states.set(id, "pending");
  if (unknown.size) {
    const reviews = await importedUnpaidReviews(db, [...unknown.keys()]);
    for (const { id, metadata } of reviews) {
      if (id && metadata.snapshot === JSON.stringify(unknown.get(id)))
        states.set(id, "confirmed_unpaid");
    }
  }
  return states;
}

export async function externallySettledAppointments(db: Pick<Database, "select">, ids: string[]) {
  if (!ids.length) return new Set<string>();
  const rows = await db
    .select({ id: auditLog.entityId })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entity, "appointment"),
        inArray(auditLog.entityId, ids),
        eq(auditLog.action, importedSettlementAudit),
      ),
    );
  return new Set(rows.flatMap(({ id }) => (id ? [id] : [])));
}

export async function importedPartialPayments(db: Pick<Database, "select">, ids: string[]) {
  if (!ids.length) return new Map<string, ExternalBalance>();
  const rows = await db
    .select({ id: auditLog.entityId, metadata: auditLog.metadata })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entity, "appointment"),
        inArray(auditLog.entityId, ids),
        eq(auditLog.action, importedPartialAudit),
      ),
    );
  return new Map(
    rows.flatMap((row) =>
      row.id ? [[row.id, externalBalanceSchema.parse(row.metadata)] as const] : [],
    ),
  );
}

export async function appointmentBillingHolds(
  db: Pick<Database, "select">,
  appointmentIds: string[],
) {
  if (!appointmentIds.length) return new Set<string>();
  const rows = await db
    .select({ id: appointmentContext.appointmentId })
    .from(appointmentContext)
    .where(and(inArray(appointmentContext.appointmentId, appointmentIds), sourceBilling));
  const unpriced = await db
    .select({ id: appointmentService.appointmentId })
    .from(appointmentService)
    .where(
      and(
        inArray(appointmentService.appointmentId, appointmentIds),
        eq(appointmentService.sourceUnpriced, true),
        isNull(appointmentService.reviewedPriceCents),
      ),
    );
  const settled = await externallySettledAppointments(db, appointmentIds);
  const partial = await importedPartialPayments(db, appointmentIds);
  const reviews = await booksyPaymentReviews(db, appointmentIds);
  return new Set([
    ...rows.filter(({ id }) => !partial.has(id)).map(({ id }) => id),
    ...unpriced.map(({ id }) => id),
    ...settled,
    ...[...reviews].flatMap(([id, state]) => (state === "pending" && !partial.has(id) ? [id] : [])),
  ]);
}

async function assertPriceCanBeReviewed(
  db: Pick<Database, "select">,
  booking: typeof appointment.$inferSelect,
  lines: (typeof appointmentService.$inferSelect)[],
) {
  if (booking.status === "cancelled" || lines.some((line) => line.currency !== "EUR"))
    throw new DomainError("invalid_state", "This appointment cannot be repriced at checkout");
  const [receipt] = await db
    .select({ id: checkout.id })
    .from(checkout)
    .where(and(eq(checkout.appointmentId, booking.id), ne(checkout.status, "void")))
    .limit(1);
  if (
    receipt ||
    (await externallySettledAppointments(db, [booking.id])).size ||
    (await importedPartialPayments(db, [booking.id])).size
  )
    throw new DomainError(
      "invalid_state",
      "Review the existing payment, invoice or checkout first",
    );
}

async function importedSettlement(db: Pick<Database, "select">, id: string) {
  const [row] = await db
    .select({ metadata: auditLog.metadata, createdAt: auditLog.createdAt })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entity, "appointment"),
        eq(auditLog.entityId, id),
        eq(auditLog.action, importedSettlementAudit),
      ),
    );
  return row
    ? recordedImportedSettlementSchema.parse({
        ...row.metadata,
        recordedAt: row.createdAt.toISOString(),
      })
    : null;
}

export async function getImportedSettlement(db: Database, id: string, principal: Principal) {
  requireRole(principal, "owner");
  const [booking] = await db
    .select({ deletedAt: appointment.deletedAt, version: appointment.version })
    .from(appointment)
    .where(eq(appointment.id, id));
  if (!booking || booking.deletedAt) throw new DomainError("not_found", "Appointment not found");
  return { appointmentVersion: booking.version, settlement: await importedSettlement(db, id) };
}

async function assertNoNativeCollection(db: Pick<Database, "select">, id: string) {
  const [receipt] = await db
    .select({ id: checkout.id })
    .from(checkout)
    .where(and(eq(checkout.appointmentId, id), ne(checkout.status, "void")))
    .limit(1);
  if (receipt)
    throw new DomainError("invalid_state", "Reconcile the existing Citame checkout first");
  const [nativeDeposit] = await db
    .select({ id: bookingProtection.appointmentId })
    .from(bookingProtection)
    .where(eq(bookingProtection.appointmentId, id));
  if (nativeDeposit)
    throw new DomainError("invalid_state", "Reconcile the existing Citame deposit first");
}

/** Acknowledges a full settlement in the source system without generating a new sale. */
export async function confirmImportedSettlement(
  db: Database,
  id: string,
  input: ImportedSettlement,
  principal: Principal,
  now: Date,
) {
  requireRole(principal, "owner");
  return db.transaction(async (tx) => {
    await lockScheduling(tx);
    const [booking] = await tx
      .select()
      .from(appointment)
      .where(eq(appointment.id, id))
      .for("update");
    if (!booking || booking.deletedAt) throw new DomainError("not_found", "Appointment not found");
    const previous = await importedSettlement(tx, id);
    if (previous) {
      if (previous.amountCents === input.amountCents && previous.reference === input.reference)
        return { appointmentVersion: booking.version, settlement: previous };
      throw new DomainError("version_conflict", "The imported settlement was already reconciled");
    }
    if ((await importedPartialPayments(tx, [id])).size)
      throw new DomainError("invalid_state", "A Booksy partial payment is already reconciled");
    if (booking.version !== input.appointmentVersion)
      throw new DomainError(
        "version_conflict",
        "Reload the current appointment before reconciling",
      );
    if (booking.status === "cancelled")
      throw new DomainError("invalid_state", "Cancelled appointments cannot be settled");
    const [source] = await tx
      .select({ id: appointmentContext.id })
      .from(appointmentContext)
      .where(and(eq(appointmentContext.appointmentId, id), sourceBilling))
      .limit(1);
    const unknown = !source && (await unknownBooksyPayments(tx, [id])).has(id);
    if (!source && !unknown)
      throw new DomainError(
        "invalid_state",
        "This appointment has no Booksy payment or invoice to reconcile",
      );
    await assertNoNativeCollection(tx, id);
    const lines = await tx
      .select()
      .from(appointmentService)
      .where(eq(appointmentService.appointmentId, id));
    if (!lines.length || lines.some((line) => line.currency !== "EUR"))
      throw new DomainError("invalid_state", "Expected frozen appointment charges in euros");
    const known = lines.every((line) => !line.sourceUnpriced || line.reviewedPriceCents !== null);
    const frozenTotal = lines.reduce(
      (sum, line) => sum + (line.reviewedPriceCents ?? line.priceCents),
      0,
    );
    if (
      (known && input.amountCents !== frozenTotal) ||
      ((!known || unknown) && input.amountCents === 0)
    )
      throw new DomainError("validation_error", "Review the full amount already settled in Booksy");
    const { amountCents, reference } = input;
    await recordAudit(tx, {
      actorUserId: principal.userId,
      action: importedSettlementAudit,
      entity: "appointment",
      entityId: id,
      metadata: { amountCents, reference },
    });
    await tx
      .update(appointment)
      .set({ version: booking.version + 1, updatedAt: now })
      .where(eq(appointment.id, id));
    return {
      appointmentVersion: booking.version + 1,
      settlement: await importedSettlement(tx, id),
    };
  });
}

/** Records evidence that an undocumented source payment is absent without generating a sale. */
export async function confirmImportedUnpaid(
  db: Database,
  id: string,
  input: ImportedUnpaidReview,
  principal: Principal,
  now: Date,
) {
  requireRole(principal, "owner");
  return db.transaction(async (tx) => {
    await lockScheduling(tx);
    const [booking] = await tx
      .select()
      .from(appointment)
      .where(eq(appointment.id, id))
      .for("update");
    if (!booking || booking.deletedAt) throw new DomainError("not_found", "Appointment not found");
    const lines = (await unknownBooksyPayments(tx, [id])).get(id);
    const [source] = await tx
      .select({ id: appointmentContext.id })
      .from(appointmentContext)
      .where(and(eq(appointmentContext.appointmentId, id), sourceBilling))
      .limit(1);
    if (!lines || source || booking.status === "cancelled")
      throw new DomainError("invalid_state", "No unknown Booksy payment can be confirmed unpaid");
    const snapshot = JSON.stringify(lines);
    const previous = (await importedUnpaidReviews(tx, [id])).find(
      ({ metadata }) => metadata.snapshot === snapshot,
    );
    if (previous?.metadata.reference === input.reference)
      return { appointmentVersion: booking.version };
    if (previous || booking.version !== input.appointmentVersion)
      throw new DomainError("version_conflict", "Reload the appointment before reviewing payment");
    if (
      (await externallySettledAppointments(tx, [id])).size ||
      (await importedPartialPayments(tx, [id])).size
    )
      throw new DomainError("invalid_state", "A Booksy payment is already reconciled");
    await assertNoNativeCollection(tx, id);
    await recordAudit(tx, {
      actorUserId: principal.userId,
      action: importedUnpaidAudit,
      entity: "appointment",
      entityId: id,
      metadata: { snapshot, reference: input.reference },
    });
    await tx
      .update(appointment)
      .set({ version: booking.version + 1, updatedAt: now })
      .where(eq(appointment.id, id));
    return { appointmentVersion: booking.version + 1 };
  });
}

async function originalPartialPaymentTotal(
  db: Pick<Database, "select">,
  booking: typeof appointment.$inferSelect,
) {
  const id = booking.id;
  if (booking.status === "cancelled" || (await externallySettledAppointments(db, [id])).size)
    throw new DomainError("invalid_state", "This appointment cannot receive an external balance");
  const [source] = await db
    .select({ id: appointmentContext.id })
    .from(appointmentContext)
    .where(and(eq(appointmentContext.appointmentId, id), eq(appointmentContext.source, "booksy")))
    .limit(1);
  if (!source) throw new DomainError("invalid_state", "This appointment has no Booksy origin");
  await assertNoNativeCollection(db, id);
  const lines = await db
    .select()
    .from(appointmentService)
    .where(eq(appointmentService.appointmentId, id));
  if (
    !lines.length ||
    lines.some(
      (line) =>
        line.currency !== "EUR" || (line.sourceUnpriced && line.reviewedPriceCents === null),
    )
  )
    throw new DomainError("invalid_state", "Review the full original appointment price first");
  const total = lines.reduce((sum, line) => sum + (line.reviewedPriceCents ?? line.priceCents), 0);
  if (!moneyCentsSchema.safeParse(total).success || total <= 0)
    throw new DomainError("invalid_state", "Expected a positive original appointment price");
  return total;
}

export async function previewImportedPartialPayment(
  db: Database,
  id: string,
  principal: Principal,
) {
  requireRole(principal, "owner");
  return db.transaction(
    async (tx) => {
      const [booking] = await tx.select().from(appointment).where(eq(appointment.id, id));
      if (!booking || booking.deletedAt)
        throw new DomainError("not_found", "Appointment not found");
      const externalBalance = (await importedPartialPayments(tx, [id])).get(id);
      return externalBalance
        ? { appointmentVersion: booking.version, externalBalance }
        : {
            appointmentVersion: booking.version,
            originalTotalCents: await originalPartialPaymentTotal(tx, booking),
          };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

export async function confirmImportedPartialPayment(
  db: Database,
  id: string,
  input: ImportedSettlement,
  principal: Principal,
  now: Date,
) {
  requireRole(principal, "owner");
  return db.transaction(async (tx) => {
    await lockScheduling(tx);
    const [booking] = await tx
      .select()
      .from(appointment)
      .where(eq(appointment.id, id))
      .for("update");
    if (!booking || booking.deletedAt) throw new DomainError("not_found", "Appointment not found");
    const [previous] = await tx
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entity, "appointment"),
          eq(auditLog.entityId, id),
          eq(auditLog.action, importedPartialAudit),
        ),
      );
    if (previous) {
      const externalBalance = externalBalanceSchema.parse(previous.metadata);
      if (
        externalBalance.paidInBooksyCents === input.amountCents &&
        previous.metadata.reference === input.reference
      )
        return { appointmentVersion: booking.version, externalBalance };
      throw new DomainError("version_conflict", "A Booksy partial payment is already reconciled");
    }
    if (booking.version !== input.appointmentVersion)
      throw new DomainError(
        "version_conflict",
        "Reload the current appointment before reconciling",
      );
    const total = await originalPartialPaymentTotal(tx, booking);
    if (input.amountCents <= 0 || input.amountCents >= total)
      throw new DomainError(
        "validation_error",
        "The external payment must be smaller than the verified full price",
      );
    const externalBalance = {
      paidInBooksyCents: input.amountCents,
      dueInCitameCents: total - input.amountCents,
    };
    await recordAudit(tx, {
      actorUserId: principal.userId,
      action: importedPartialAudit,
      entity: "appointment",
      entityId: id,
      metadata: { ...externalBalance, reference: input.reference },
    });
    await tx
      .update(appointment)
      .set({ version: booking.version + 1, updatedAt: now })
      .where(eq(appointment.id, id));
    return { appointmentVersion: booking.version + 1, externalBalance };
  });
}

export async function previewImportedAppointmentPrice(
  db: Database,
  id: string,
  principal: Principal,
): Promise<ImportedPriceReviewPreview> {
  requireRole(principal, "owner");
  return db.transaction(
    async (tx) => {
      const [booking] = await tx.select().from(appointment).where(eq(appointment.id, id));
      if (!booking || booking.deletedAt)
        throw new DomainError("not_found", "Appointment not found");
      const lines = await tx
        .select()
        .from(appointmentService)
        .where(eq(appointmentService.appointmentId, id))
        .orderBy(asc(appointmentService.position));
      const imported = lines.filter((line) => line.sourceUnpriced);
      if (!imported.length || imported.some((line) => line.reviewedPriceCents !== null))
        throw new DomainError(
          "invalid_state",
          "This appointment has no pending imported price review",
        );
      await assertPriceCanBeReviewed(tx, booking, lines);
      return {
        appointmentVersion: booking.version,
        lines: imported.map(({ id, name }) => ({ id, name })),
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

/** Preserve the frozen source quote and record one reviewed amount for each unknown line. */
export async function reviewImportedAppointmentPrice(
  db: Database,
  id: string,
  input: ImportedPriceReview,
  principal: Principal,
  now: Date,
) {
  requireRole(principal, "owner");
  return db.transaction(async (tx) => {
    // Same order as checkout creation. No receipt can be built with a partly reviewed price.
    await lockScheduling(tx);
    const [booking] = await tx
      .select()
      .from(appointment)
      .where(eq(appointment.id, id))
      .for("update");
    if (!booking || booking.deletedAt) throw new DomainError("not_found", "Appointment not found");
    const lines = await tx
      .select()
      .from(appointmentService)
      .where(eq(appointmentService.appointmentId, id));
    const imported = lines.filter((line) => line.sourceUnpriced);
    const amounts = new Map(input.lines.map(({ id, amountCents }) => [id, amountCents]));
    if (
      !imported.length ||
      amounts.size !== imported.length ||
      imported.some((line) => !amounts.has(line.id))
    )
      throw new DomainError("validation_error", "Include each unpriced imported service");
    if (imported.every((line) => line.reviewedPriceCents === amounts.get(line.id))) {
      const [previous] = await tx
        .select({ metadata: auditLog.metadata })
        .from(auditLog)
        .where(and(eq(auditLog.action, importedPriceReviewAudit), eq(auditLog.entityId, id)));
      if (previous?.metadata.reference === input.reference) return { ok: true as const };
    }
    if (
      booking.version !== input.appointmentVersion ||
      imported.some((line) => line.reviewedPriceCents !== null)
    )
      throw new DomainError("version_conflict", "Reload the current appointment and price review");
    if (
      !moneyCentsSchema.safeParse(
        lines.reduce((sum, line) => sum + (amounts.get(line.id) ?? line.priceCents), 0),
      ).success
    )
      throw new DomainError(
        "validation_error",
        "The reviewed total is outside the supported range",
      );
    await assertPriceCanBeReviewed(tx, booking, lines);
    for (const [lineId, amount] of amounts) {
      await tx
        .update(appointmentService)
        .set({ reviewedPriceCents: amount })
        .where(eq(appointmentService.id, lineId));
    }
    await tx
      .update(appointment)
      .set({ version: booking.version + 1, updatedAt: now })
      .where(eq(appointment.id, id));
    await recordAudit(tx, {
      actorUserId: principal.userId,
      action: importedPriceReviewAudit,
      entity: "appointment",
      entityId: id,
      metadata: { reference: input.reference, lines: input.lines },
    });
    return { ok: true as const };
  });
}

export async function assertAppointmentBillable(
  db: Pick<Database, "select">,
  appointmentId: string,
) {
  if ((await appointmentBillingHolds(db, [appointmentId])).size)
    throw new DomainError(
      "invalid_state",
      "Reconcile the imported price, payment or invoice before collecting this appointment",
    );
}
