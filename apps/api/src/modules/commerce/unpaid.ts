import { type CalendarQuery, permissionsFor, type UnpaidAppointments } from "@sob/contracts";
import { checkout, checkoutPayment, type Database } from "@sob/db";
import { and, inArray, sql } from "drizzle-orm";
import { authorizeCalendarQuery } from "../../auth/policy";
import type { Principal } from "../../auth/principal";
import { getCalendar } from "../appointments/calendar";
import { requireOperator } from "./service";

/** The cashier sees the intersection of calendar and sales access. No recent-receipt
 * limit: a fully collected appointment stays out even after thousands of other sales. */
export async function unpaidAppointments(
  db: Database,
  query: CalendarQuery,
  principal: Principal,
): Promise<UnpaidAppointments> {
  requireOperator(principal);
  const scope = authorizeCalendarQuery(principal, query);
  if (!permissionsFor(principal.role, principal.accessPreset).allSales)
    scope.staffIds = principal.staffId ? [principal.staffId] : [];
  return db.transaction(
    async (tx) => {
      const calendar = await getCalendar(tx, query, { ...scope, includeInactiveStaff: true });
      const candidates = calendar.appointments.filter(
        (row) => row.status !== "cancelled" && !row.externallySettled,
      );
      const settled = candidates.length
        ? await tx
            .select({ appointmentId: checkout.appointmentId })
            .from(checkout)
            .where(
              and(
                inArray(
                  checkout.appointmentId,
                  candidates.map((row) => row.id),
                ),
                sql`${checkout.status} <> 'void'`,
                sql`coalesce((select sum(${checkoutPayment.amountCents}) from ${checkoutPayment} where ${checkoutPayment.checkoutId}=${checkout.id} and ${checkoutPayment.status}='succeeded'),0) >= ${checkout.totalCents}`,
              ),
            )
        : [];
      const paid = new Set(settled.map(({ appointmentId }) => appointmentId));
      const billingReview = candidates.flatMap((row) =>
        row.billingReviewReasons
          ? [
              {
                id: row.id,
                clientName: row.clientName,
                staffId: row.staffId,
                startsAt: row.startsAt,
                serviceNames: row.serviceNames,
                reasons: row.billingReviewReasons,
              },
            ]
          : [],
      );
      return {
        appointments: candidates.filter((row) => !row.billingReviewReasons && !paid.has(row.id)),
        ...(billingReview.length ? { billingReview } : {}),
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
