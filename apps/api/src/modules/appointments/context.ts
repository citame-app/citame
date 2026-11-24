import { createHash } from "node:crypto";
import type {
  AppointmentContextUpdate,
  BillingReviewReason,
  BooksyContextImport,
  CalendarServiceBadges,
  ExternalBalance,
} from "@sob/contracts";
import { permissionsFor } from "@sob/contracts";
import {
  appointment,
  appointmentContext,
  appointmentService,
  checkout,
  type Database,
  staffProfile,
} from "@sob/db";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { authorizeCalendarQuery, requirePermission, requireRole } from "../../auth/policy";
import type { Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import { lockScheduling, type Tx } from "../../tx";
import { appointmentDepositStatus, protectionView } from "../booking-protection/value";
import {
  booksyPaymentReviews,
  externallySettledAppointments,
  importedPartialPaymentReviews,
  invalidateLegacyPartialPayments,
} from "../commerce/appointment-billing";
import { saleRow } from "../commerce/service";
import { hasGroupedCheckout } from "./visit-checkout-access";

type Connection = Database | Tx;
const conflict = () =>
  new DomainError("version_conflict", "Reload the appointment and review its annotations again");

async function authorizedAppointment(db: Connection, id: string, principal: Principal) {
  const scope = authorizeCalendarQuery(principal, {});
  const [row] = await db
    .select()
    .from(appointment)
    .where(and(eq(appointment.id, id), isNull(appointment.deletedAt)));
  if (!row || (scope.staffIds && !scope.staffIds.includes(row.staffId)))
    throw new DomainError("not_found", "Appointment not found");
  return row;
}
export async function getAppointmentContext(db: Connection, id: string, principal: Principal) {
  const visit = await authorizedAppointment(db, id, principal);
  const { commerce, editCalendar } = permissionsFor(principal.role, principal.accessPreset);
  const [rows, protection, hasVisitCheckout] = await Promise.all([
    db.select().from(appointmentContext).where(eq(appointmentContext.appointmentId, id)),
    protectionView(db, id),
    hasGroupedCheckout(db, id, authorizeCalendarQuery(principal, {}).visitCheckoutScope),
  ]);
  const receipt =
    commerce && protection
      ? await saleRow(db, protection.checkoutId, principal).catch((error: unknown) => {
          if (error instanceof DomainError && error.code === "not_found") return null;
          throw error;
        })
      : null;
  return {
    appointmentVersion: visit.version,
    canEdit: editCalendar,
    defaultRequested: visit.requestedStaffId !== null,
    ...(hasVisitCheckout ? { hasVisitCheckout: true as const } : {}),
    ...(protection
      ? {
          protection: {
            ...appointmentDepositStatus(protection),
            ...(receipt?.appointmentId === id
              ? { checkoutId: receipt.id }
              : { receiptRestricted: true as const }),
            ...(commerce
              ? {
                  depositCents: protection.depositCents,
                  feeCents: protection.feeCents,
                  refundDueCents: protection.refundDueCents,
                }
              : {}),
          },
        }
      : {}),
    ...(visit.sourceBusinessMessage ? { businessMessage: visit.sourceBusinessMessage } : {}),
    customerComment: visit.customerComment,
    rows: rows
      .sort((a, b) => a.servicePosition - b.servicePosition)
      .map(
        ({
          id: _id,
          appointmentId: _appointmentId,
          updatedAt: _updatedAt,
          billingVersion: _billingVersion,
          sourcePaymentUnverified: _sourcePaymentUnverified,
          ...row
        }) => (commerce ? row : { ...row, invoiced: null, paid: null }),
      ),
  };
}

export async function updateAppointmentContext(
  db: Database,
  id: string,
  input: AppointmentContextUpdate,
  principal: Principal,
  now: Date,
) {
  requirePermission(principal, "editCalendar");
  return db.transaction(async (tx) => {
    await lockScheduling(tx);
    const visit = await authorizedAppointment(tx, id, principal);
    const [snapshot] = await tx
      .select()
      .from(appointmentService)
      .where(
        and(
          eq(appointmentService.appointmentId, id),
          eq(appointmentService.position, input.servicePosition),
        ),
      );
    if (!snapshot) throw new DomainError("validation_error", "Unknown booked service position");
    const [current] = await tx
      .select()
      .from(appointmentContext)
      .where(
        and(
          eq(appointmentContext.appointmentId, id),
          eq(appointmentContext.servicePosition, input.servicePosition),
        ),
      );
    if (visit.version !== input.appointmentVersion || (current?.version ?? 0) !== input.version)
      throw conflict();
    const values = {
      requestedStaffId:
        input.requested === undefined
          ? current
            ? current.requestedStaffId
            : visit.requestedStaffId
          : input.requested
            ? visit.staffId
            : null,
      internalNote: input.internalNote.trim() || null,
      updatedAt: now,
    };
    if (current)
      await tx
        .update(appointmentContext)
        .set({ ...values, version: current.version + 1 })
        .where(eq(appointmentContext.id, current.id));
    else
      await tx
        .insert(appointmentContext)
        .values({ ...values, appointmentId: id, servicePosition: input.servicePosition });
    const changed = await tx
      .update(appointment)
      .set({ version: visit.version + 1, updatedAt: now })
      .where(and(eq(appointment.id, id), eq(appointment.version, visit.version)))
      .returning({ id: appointment.id });
    if (!changed.length) throw conflict();
    await recordAudit(tx, {
      actorUserId: principal.userId,
      action: "appointment.context.update",
      entity: "appointment",
      entityId: id,
      metadata: {
        servicePosition: input.servicePosition,
        internalNote: Boolean(values.internalNote),
        requested: input.requested,
      },
    });
    return getAppointmentContext(tx, id, principal);
  });
}

/** Batched annotation flags with optional financial state. */
export async function calendarBadges(
  db: Connection,
  visits: Pick<typeof appointment.$inferSelect, "id" | "requestedStaffId" | "customerComment">[],
  snapshots: Pick<
    typeof appointmentService.$inferSelect,
    "appointmentId" | "position" | "sourceUnpriced" | "reviewedPriceCents"
  >[],
  { includeBilling }: { includeBilling: boolean },
) {
  const result = new Map<
    string,
    {
      badges: CalendarServiceBadges[];
      reasons: BillingReviewReason[];
      externallySettled: boolean;
      importedFromBooksy: boolean;
      booksyUnpaidConfirmed: boolean;
      externalBalance?: ExternalBalance;
    }
  >();
  if (!visits.length) return result;
  const ids = visits.map((v) => v.id);
  const [contexts, receipts, externallySettled, partial, unknownPayments] = await Promise.all([
    db
      .select({
        appointmentId: appointmentContext.appointmentId,
        servicePosition: appointmentContext.servicePosition,
        requestedStaffId: appointmentContext.requestedStaffId,
        invoiced: appointmentContext.invoiced,
        paid: appointmentContext.paid,
        source: appointmentContext.source,
        internalNote: sql<boolean>`coalesce(length(btrim(${appointmentContext.internalNote}))>0,false)`,
        customerComment: sql<boolean>`coalesce(length(btrim(${appointmentContext.customerComment}))>0,false)`,
      })
      .from(appointmentContext)
      .where(inArray(appointmentContext.appointmentId, ids)),
    includeBilling
      ? db
          .select({ appointmentId: checkout.appointmentId, status: checkout.status })
          .from(checkout)
          .where(
            and(
              inArray(checkout.appointmentId, ids),
              inArray(checkout.status, ["paid", "partially_refunded", "refunded"]),
            ),
          )
      : [],
    includeBilling ? externallySettledAppointments(db, ids) : null,
    includeBilling ? importedPartialPaymentReviews(db, ids) : null,
    includeBilling ? booksyPaymentReviews(db, ids) : null,
  ]);
  const indexed = new Map(contexts.map((c) => [`${c.appointmentId}:${c.servicePosition}`, c]));
  const paidInBooksy = new Set<string>();
  const invoicedInBooksy = new Set<string>();
  const imported = new Set<string>();
  for (const context of contexts) {
    if (context.source !== "booksy") continue;
    imported.add(context.appointmentId);
    if (includeBilling && context.paid) paidInBooksy.add(context.appointmentId);
    if (includeBilling && context.invoiced) invoicedInBooksy.add(context.appointmentId);
  }
  const billed = new Map(receipts.map((r) => [r.appointmentId, r.status]));
  const grouped = new Map<string, typeof snapshots>();
  for (const snapshot of snapshots) {
    const own = grouped.get(snapshot.appointmentId) ?? [];
    own.push(snapshot);
    grouped.set(snapshot.appointmentId, own);
  }
  for (const visit of visits) {
    const services = grouped.get(visit.id) ?? [];
    const partialReview = partial?.get(visit.id);
    const settled = externallySettled?.has(visit.id) ?? false;
    const partialNeedsReview = partialReview && !partialReview.current && !settled;
    const externalBalance = partialReview?.current && !settled ? partialReview.balance : undefined;
    const reasons: BillingReviewReason[] = [];
    if (includeBilling && services.some((s) => s.sourceUnpriced && s.reviewedPriceCents === null))
      reasons.push("unknown_amount");
    if (!externalBalance && !partialNeedsReview && paidInBooksy.has(visit.id))
      reasons.push("paid_in_booksy");
    if (!externalBalance && !partialNeedsReview && invoicedInBooksy.has(visit.id))
      reasons.push("invoiced_in_booksy");
    const paymentReview =
      !externalBalance &&
      !settled &&
      !partialReview &&
      !paidInBooksy.has(visit.id) &&
      !invoicedInBooksy.has(visit.id)
        ? unknownPayments?.get(visit.id)
        : undefined;
    if (partialNeedsReview) reasons.push("booksy_balance_changed");
    if (paymentReview === "pending") reasons.push("unknown_booksy_payment");
    result.set(visit.id, {
      reasons,
      externallySettled: settled,
      importedFromBooksy: imported.has(visit.id),
      booksyUnpaidConfirmed: paymentReview === "confirmed_unpaid",
      externalBalance,
      badges: services.map((s) => {
        const c = indexed.get(`${visit.id}:${s.position}`);
        const native = billed.get(visit.id);
        const billingContext = includeBilling ? c : undefined;
        const annotatedPaid = !externalBalance && billingContext?.paid === true;
        return {
          servicePosition: s.position,
          requested: Boolean(c ? c.requestedStaffId : visit.requestedStaffId),
          invoiced: Boolean(native || billingContext?.invoiced),
          paid: native ? native !== "refunded" : annotatedPaid,
          billingSource: native
            ? "citame"
            : billingContext && (billingContext.invoiced || annotatedPaid)
              ? (billingContext.source as "booksy" | "citame")
              : null,
          internalNote: c?.internalNote ?? false,
          customerComment: Boolean(c?.customerComment || visit.customerComment?.trim()),
        };
      }),
    });
  }
  return result;
}
const digest = (input: unknown) => createHash("sha256").update(JSON.stringify(input)).digest("hex");
function sameContext(
  a: typeof appointmentContext.$inferSelect | undefined,
  b: BooksyContextImport["rows"][number],
) {
  return Boolean(
    a &&
      a.source === "booksy" &&
      a.sourceRef === b.sourceRef &&
      a.requestedStaffId === b.requestedStaffId &&
      a.internalNote === b.internalNote &&
      a.customerComment === b.customerComment &&
      a.invoiced === b.invoiced &&
      a.paid === b.paid,
  );
}
async function prepareImport(
  db: Connection,
  input: BooksyContextImport,
  principal: Principal,
  now: Date,
) {
  requireRole(principal, "owner");
  const ids = [...new Set(input.rows.map((r) => r.appointmentId))];
  const [visits, contexts, snapshots, staff] = await Promise.all([
    db
      .select()
      .from(appointment)
      .where(and(inArray(appointment.id, ids), isNull(appointment.deletedAt))),
    db
      .select()
      .from(appointmentContext)
      .where(
        or(
          inArray(appointmentContext.appointmentId, ids),
          inArray(
            appointmentContext.sourceRef,
            input.rows.map((r) => r.sourceRef),
          ),
        ),
      ),
    db.select().from(appointmentService).where(inArray(appointmentService.appointmentId, ids)),
    db.select({ id: staffProfile.id }).from(staffProfile),
  ]);
  const byId = new Map(visits.map((v) => [v.id, v]));
  const byPosition = new Map(contexts.map((c) => [`${c.appointmentId}:${c.servicePosition}`, c]));
  const bySource = new Map(
    contexts.filter((c) => c.source === "booksy" && c.sourceRef).map((c) => [c.sourceRef, c]),
  );
  const positions = new Set(snapshots.map((s) => `${s.appointmentId}:${s.position}`));
  const staffIds = new Set(staff.map((s) => s.id));
  for (const r of input.rows) {
    const key = `${r.appointmentId}:${r.servicePosition}`;
    const visit = byId.get(r.appointmentId);
    const current = byPosition.get(key);
    const linked = bySource.get(r.sourceRef);
    if (visit && visit.startsAt <= now)
      throw new DomainError("validation_error", "Only future appointments can be imported");
    if (!visit || !positions.has(key) || (r.requestedStaffId && !staffIds.has(r.requestedStaffId)))
      throw new DomainError(
        "validation_error",
        "Explicit appointment, booked service and professional mappings are required",
      );
    if (
      linked &&
      (linked.appointmentId !== r.appointmentId || linked.servicePosition !== r.servicePosition)
    )
      throw new DomainError(
        "invalid_state",
        "This Booksy service is already mapped to another appointment",
      );
    if (sameContext(current, r)) continue;
    if (visit.version !== r.appointmentVersion || (current?.version ?? 0) !== r.contextVersion)
      throw conflict();
  }
  return {
    visits,
    byPosition,
    review: {
      items: input.rows.map((r) => ({
        appointmentId: r.appointmentId,
        servicePosition: r.servicePosition,
        sourceRef: r.sourceRef,
        serviceName:
          snapshots.find(
            (s) => s.appointmentId === r.appointmentId && s.position === r.servicePosition,
          )?.name ?? "",
        startsAt: byId.get(r.appointmentId)!.startsAt.toISOString(),
        action: sameContext(byPosition.get(`${r.appointmentId}:${r.servicePosition}`), r)
          ? ("unchanged" as const)
          : byPosition.has(`${r.appointmentId}:${r.servicePosition}`)
            ? ("update" as const)
            : ("add" as const),
      })),
      reviewHash: digest(input),
      appointments: ids.length,
      services: input.rows.length,
      internalNotes: input.rows.filter((r) => r.internalNote?.trim()).length,
      customerComments: input.rows.filter((r) => r.customerComment?.trim()).length,
      requested: input.rows.filter((r) => r.requestedStaffId).length,
      invoiced: input.rows.filter((r) => r.invoiced).length,
      paid: input.rows.filter((r) => r.paid).length,
    },
  };
}
export async function previewBooksyContext(
  db: Database,
  input: BooksyContextImport,
  principal: Principal,
  now: Date,
) {
  return (await prepareImport(db, input, principal, now)).review;
}
export async function importBooksyContext(
  db: Database,
  input: BooksyContextImport,
  reviewHash: string,
  principal: Principal,
  now: Date,
) {
  requireRole(principal, "owner");
  if (digest(input) !== reviewHash)
    throw new DomainError("validation_error", "Review this exact import before applying it");
  return db.transaction(async (tx) => {
    await lockScheduling(tx);
    const prepared = await prepareImport(tx, input, principal, now);
    const changed = new Set<string>();
    const financialChanges = new Set<string>();
    for (const r of input.rows) {
      const current = prepared.byPosition.get(`${r.appointmentId}:${r.servicePosition}`);
      if (sameContext(current, r)) continue;
      if (
        current?.source !== "booksy" ||
        current.sourceRef !== r.sourceRef ||
        current.paid !== r.paid ||
        current.invoiced !== r.invoiced
      )
        financialChanges.add(r.appointmentId);
      const {
        appointmentVersion: _appointmentVersion,
        contextVersion: _contextVersion,
        ...values
      } = r;
      if (current)
        await tx
          .update(appointmentContext)
          .set({ ...values, source: "booksy", version: current.version + 1, updatedAt: now })
          .where(eq(appointmentContext.id, current.id));
      else
        await tx.insert(appointmentContext).values({ ...values, source: "booksy", updatedAt: now });
      changed.add(r.appointmentId);
    }
    await invalidateLegacyPartialPayments(tx, [...financialChanges], principal.userId);
    for (const visit of prepared.visits.filter((v) => changed.has(v.id))) {
      const updated = await tx
        .update(appointment)
        .set({ version: visit.version + 1, updatedAt: now })
        .where(and(eq(appointment.id, visit.id), eq(appointment.version, visit.version)))
        .returning({ id: appointment.id });
      if (!updated.length) throw conflict();
    }
    if (changed.size)
      await recordAudit(tx, {
        actorUserId: principal.userId,
        action: "appointment.context.import",
        entity: "appointment",
        metadata: { appointments: changed.size, services: input.rows.length, source: "booksy" },
      });
    return prepared.review;
  });
}
