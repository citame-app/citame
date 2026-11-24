import {
  appointment,
  appointmentVisitPart,
  bookingProtection,
  checkout,
  type Database,
} from "@sob/db";
import { and, eq, exists, isNotNull, isNull, ne, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { VisitCheckoutScope } from "../../auth/policy";
import type { Tx } from "../../tx";

export function groupedCheckout(db: Database | Tx, scope?: VisitCheckoutScope) {
  if (!scope) return sql<boolean>`false`;
  const sibling = alias(appointment, "visit_checkout_sibling");
  const part = alias(appointmentVisitPart, "visit_checkout_part");
  const receipt = alias(checkout, "visit_checkout_receipt");
  const protection = alias(bookingProtection, "visit_checkout_protection");
  const inaccessibleReceipt = (id: typeof appointment.id | typeof sibling.id) =>
    scope.staffId === null
      ? undefined
      : exists(
          db
            .select({ id: receipt.id })
            .from(receipt)
            .leftJoin(protection, eq(protection.checkoutId, receipt.id))
            .where(
              and(
                eq(receipt.appointmentId, id),
                or(ne(receipt.status, "void"), isNotNull(protection.checkoutId)),
                or(
                  ne(receipt.staffId, scope.staffId),
                  and(
                    isNull(receipt.staffId),
                    sql`${receipt.createdBy} IS DISTINCT FROM ${scope.actorId}`,
                  ),
                ),
              ),
            ),
        );
  const member = and(isNull(sibling.deletedAt), ne(sibling.id, appointment.id));
  const outsideScope = or(
    ne(sibling.clientId, appointment.clientId),
    scope.staffId === null ? undefined : ne(sibling.staffId, scope.staffId),
    inaccessibleReceipt(sibling.id),
  );
  const nativeMembers = (denied: boolean) =>
    db
      .select({ id: sibling.id })
      .from(part)
      .innerJoin(sibling, eq(part.appointmentId, sibling.id))
      .where(
        and(
          eq(part.visitId, appointmentVisitPart.visitId),
          member,
          denied ? outsideScope : undefined,
        ),
      );
  const importedMembers = (denied: boolean) =>
    db
      .select({ id: sibling.id })
      .from(sibling)
      .where(
        and(
          eq(sibling.visitGroupId, appointment.visitGroupId),
          member,
          denied ? outsideScope : undefined,
        ),
      );
  // Keep both lookups on their group indexes. Ungrouped rows need neither lookup.
  const eligible = sql<boolean>`CASE
    WHEN ${appointmentVisitPart.visitId} IS NOT NULL THEN ${and(exists(nativeMembers(false)), notExists(nativeMembers(true)))}
    WHEN ${appointment.visitGroupId} IS NOT NULL THEN ${and(exists(importedMembers(false)), notExists(importedMembers(true)))}
    ELSE false END`;
  return sql<boolean>`(${and(
    scope.staffId === null
      ? undefined
      : and(
          eq(appointment.staffId, scope.staffId),
          sql`NOT ${inaccessibleReceipt(appointment.id)}`,
        ),
    eligible,
  )})`;
}

export async function hasGroupedCheckout(
  db: Database | Tx,
  id: string,
  scope?: VisitCheckoutScope,
) {
  if (!scope) return false;
  const [result] = await db
    .select({ eligible: groupedCheckout(db, scope) })
    .from(appointment)
    .leftJoin(appointmentVisitPart, eq(appointmentVisitPart.appointmentId, appointment.id))
    .where(and(eq(appointment.id, id), isNull(appointment.deletedAt)));
  return result?.eligible ?? false;
}
