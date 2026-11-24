import { moneyCentsSchema } from "@sob/contracts";
import { appointment, appointmentService, auditLog, type Database } from "@sob/db";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "../../tx";
import { calendarBadges } from "../appointments/context";
import { importedPriceReviewAudit } from "../commerce/appointment-billing";
import { importedAppointmentCalendarLink } from "./local-day";

type ImportedBillingReference = {
  appointmentId: string;
  sourceBookingRef: string;
  sourceLineRef: string;
};

/** The caller verifies the native projection and runs this within the same read-only snapshot. */
export async function collectImportedBillingReview(
  db: Database | Tx,
  references: ImportedBillingReference[],
  timezone: string,
) {
  const ids = references.map(({ appointmentId }) => appointmentId);
  const [visits, services] = ids.length
    ? await Promise.all([
        db
          .select({
            id: appointment.id,
            startsAt: appointment.startsAt,
            status: appointment.status,
            deletedAt: appointment.deletedAt,
            requestedStaffId: appointment.requestedStaffId,
            customerComment: appointment.customerComment,
          })
          .from(appointment)
          .where(inArray(appointment.id, ids)),
        db
          .select({
            appointmentId: appointmentService.appointmentId,
            position: appointmentService.position,
            sourceUnpriced: appointmentService.sourceUnpriced,
            reviewedPriceCents: appointmentService.reviewedPriceCents,
          })
          .from(appointmentService)
          .where(inArray(appointmentService.appointmentId, ids)),
      ])
    : [[], []];
  const billing = await calendarBadges(db, visits, services, { includeBilling: true });
  const visitById = new Map(visits.map((visit) => [visit.id, visit]));
  const pendingByDate = new Map<string, number>();
  const rows = references.flatMap((reference) => {
    const visit = visitById.get(reference.appointmentId);
    const state = billing.get(reference.appointmentId);
    if (!visit || !state?.importedFromBooksy)
      throw new Error("A verified Booksy appointment is missing from the billing review");
    if (
      visit.deletedAt ||
      visit.status === "cancelled" ||
      state.externallySettled ||
      !state.reasons.length
    )
      return [];
    const link = importedAppointmentCalendarLink(visit.id, visit.startsAt.toISOString(), timezone);
    pendingByDate.set(link.calendarDate, (pendingByDate.get(link.calendarDate) ?? 0) + 1);
    return [
      {
        ...reference,
        ...link,
        reasons: state.reasons,
      },
    ];
  });
  return {
    pendingAppointments: rows.length,
    pendingByDate: [...pendingByDate]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, appointments]) => ({ date, appointments })),
    rows: rows.sort(
      (a, b) =>
        a.calendarDate.localeCompare(b.calendarDate) ||
        a.appointmentId.localeCompare(b.appointmentId),
    ),
  };
}

const reviewedLines = z.array(z.object({ id: z.uuid(), amountCents: moneyCentsSchema })).min(1);

/** Reviewed amounts live alongside the immutable source price and require matching audit evidence. */
export async function verifyImportedPriceReviews(
  tx: Tx,
  services: Pick<
    typeof appointmentService.$inferSelect,
    "id" | "appointmentId" | "sourceUnpriced" | "reviewedPriceCents"
  >[],
) {
  if (!services.length) return;
  const ids = [...new Set(services.map(({ appointmentId }) => appointmentId))];
  const records = await tx
    .select({ appointmentId: auditLog.entityId, metadata: auditLog.metadata })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entity, "appointment"),
        eq(auditLog.action, importedPriceReviewAudit),
        inArray(auditLog.entityId, ids),
      ),
    );
  const audits = new Map<string, number>();
  const reviewedAppointments = new Set<string>();
  const unpricedByAppointment = new Map<string, Set<string>>();
  for (const { id, appointmentId, sourceUnpriced } of services) {
    if (!sourceUnpriced) continue;
    const ids = unpricedByAppointment.get(appointmentId) ?? new Set<string>();
    ids.add(id);
    unpricedByAppointment.set(appointmentId, ids);
  }
  for (const { appointmentId, metadata } of records) {
    const parsed = reviewedLines.safeParse(metadata.lines);
    const lines = appointmentId && unpricedByAppointment.get(appointmentId);
    if (
      !appointmentId ||
      reviewedAppointments.has(appointmentId) ||
      !parsed.success ||
      !lines ||
      lines.size !== parsed.data.length
    )
      throw new Error("Imported price audit differs from the reviewed services");
    for (const { id, amountCents } of parsed.data) {
      if (!lines.has(id) || audits.has(id))
        throw new Error("Imported price audit differs from the reviewed services");
      audits.set(id, amountCents);
    }
    reviewedAppointments.add(appointmentId);
  }
  if (
    services.some(({ id, reviewedPriceCents }) => reviewedPriceCents !== (audits.get(id) ?? null))
  )
    throw new Error("Imported price audit differs from the reviewed services");
}
