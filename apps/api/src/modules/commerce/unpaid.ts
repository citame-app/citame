import { type CalendarQuery, permissionsFor, type UnpaidAppointments } from "@sob/contracts";
import { checkout, checkoutLine, checkoutPayment, checkoutRefund, type Database } from "@sob/db";
import { and, getTableName, inArray, sql } from "drizzle-orm";
import { authorizeCalendarQuery } from "../../auth/policy";
import type { Principal } from "../../auth/principal";
import { getCalendar } from "../appointments/calendar";
import { completedRefundStatus, recordedPaymentStatuses } from "./money";
import { ownsSale, requireOperator } from "./service";

/** The cashier sees the intersection of calendar and sales access. No recent-receipt
 * limit: a fully collected appointment stays out even after thousands of other sales. */
export async function unpaidAppointments(
  db: Database,
  query: CalendarQuery,
  principal: Principal,
): Promise<UnpaidAppointments> {
  requireOperator(principal);
  const scope = authorizeCalendarQuery(principal, query);
  const { allSales } = permissionsFor(principal.role, principal.accessPreset);
  if (!allSales) scope.staffIds = principal.staffId ? [principal.staffId] : [];
  return db.transaction(
    async (tx) => {
      const calendar = await getCalendar(tx, query, { ...scope, includeInactiveStaff: true });
      const candidates = calendar.appointments.filter(
        (row) => row.status !== "cancelled" && !row.externallySettled,
      );
      const ids = candidates.filter((row) => !row.billingReviewReasons).map((row) => row.id);
      // Drizzle can omit column qualifiers in a single-table projection.
      // Keep the outer ID qualified inside the correlated payment and line lookups.
      const receiptId = sql`${sql.identifier(getTableName(checkout))}.${sql.identifier(checkout.id.name)}`;
      const paymentId = sql`${sql.identifier(getTableName(checkoutPayment))}.${sql.identifier(checkoutPayment.id.name)}`;
      const receipts = ids.length
        ? await tx
            .select({
              appointmentId: checkout.appointmentId,
              id: checkout.id,
              staffId: checkout.staffId,
              createdBy: checkout.createdBy,
              totalCents: checkout.totalCents,
              status: checkout.status,
              recordedCents: sql<number>`coalesce((
                select sum(${checkoutPayment.amountCents}) from ${checkoutPayment}
                where ${checkoutPayment.checkoutId} = ${receiptId} and ${inArray(checkoutPayment.status, recordedPaymentStatuses)}
              ), 0)`.mapWith(Number),
              confirmedCents: sql<number>`coalesce((
                select sum(${checkoutPayment.amountCents}) from ${checkoutPayment}
                where ${checkoutPayment.checkoutId} = ${receiptId} and ${checkoutPayment.status} = 'succeeded'
              ), 0)`.mapWith(Number),
              paymentInProgress: sql<boolean>`exists (
                select 1 from ${checkoutPayment}
                where ${checkoutPayment.checkoutId} = ${receiptId}
                and (
                  ${checkoutPayment.status} = 'pending'
                  or (
                    ${checkoutPayment.status} = 'reconciliation' and coalesce((
                      select sum(${checkoutRefund.amountCents}) from ${checkoutRefund}
                      where ${checkoutRefund.paymentId} = ${paymentId}
                        and ${checkoutRefund.status} = ${completedRefundStatus}
                    ), 0) < ${checkoutPayment.amountCents}
                  )
                )
              )`,
              pricePending: sql<boolean>`exists (
                select 1 from ${checkoutLine}
                where ${checkoutLine.checkoutId} = ${receiptId} and ${checkoutLine.pricePending}
              )`,
            })
            .from(checkout)
            .where(and(inArray(checkout.appointmentId, ids), sql`${checkout.status} <> 'void'`))
        : [];
      const byAppointment = new Map(receipts.map((receipt) => [receipt.appointmentId, receipt]));
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
        appointments: candidates.flatMap((row) => {
          if (row.billingReviewReasons) return [];
          const receipt = byAppointment.get(row.id);
          if (!receipt) return [row];
          const balance = receipt.totalCents - receipt.recordedCents;
          if (!receipt.pricePending && receipt.confirmedCents >= receipt.totalCents) return [];
          // Refunded or closed receipts do not open a new collectible balance.
          if (
            !receipt.pricePending &&
            !receipt.paymentInProgress &&
            (receipt.status !== "open" || balance <= 0)
          )
            return [];
          if (!allSales && !ownsSale(principal, receipt))
            return [{ ...row, receiptRestricted: true as const }];
          const protection = row.protection;
          const serviceBalanceDeferred =
            protection?.checkoutId === receipt.id &&
            (protection.state === "pending" || protection.state === "confirmed") &&
            row.status !== "completed";
          return [
            {
              ...row,
              receiptBalance: {
                id: receipt.id,
                confirmedCents: receipt.confirmedCents,
                balanceCents: receipt.pricePending || receipt.paymentInProgress ? null : balance,
                pricePending: receipt.pricePending,
                paymentInProgress: receipt.paymentInProgress,
                ...(serviceBalanceDeferred ? { serviceBalanceDeferred: true as const } : {}),
              },
            },
          ];
        }),
        ...(billingReview.length ? { billingReview } : {}),
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
