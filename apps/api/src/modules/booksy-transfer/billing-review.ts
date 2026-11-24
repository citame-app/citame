import { appointment, appointmentService, type Database } from "@sob/db";
import { inArray } from "drizzle-orm";
import type { Tx } from "../../tx";
import { calendarBadges } from "../appointments/context";
import { sourceCalendarDate } from "./calendar-intervals";

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
    const calendarDate = sourceCalendarDate(visit.startsAt.toISOString(), timezone);
    const query = new URLSearchParams({ date: calendarDate, view: "day", appointment: visit.id });
    pendingByDate.set(calendarDate, (pendingByDate.get(calendarDate) ?? 0) + 1);
    return [
      {
        ...reference,
        calendarDate,
        calendarPath: `/admin/calendar?${query}`,
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
