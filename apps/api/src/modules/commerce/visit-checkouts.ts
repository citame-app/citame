import { permissionsFor, type VisitCheckout } from "@sob/contracts";
import { appointment, appointmentVisitPart, type Database } from "@sob/db";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import { lockScheduling } from "../../tx";
import { appointmentBillingHolds } from "./appointment-billing";
import { createCheckoutInTransaction, requireOperator } from "./service";

const maxVisitAppointments = 24;

export async function prepareVisitCheckouts(
  db: Database,
  appointmentId: string,
  principal: Principal,
): Promise<VisitCheckout> {
  requireOperator(principal);
  const permissions = permissionsFor(principal.role, principal.accessPreset);
  return db.transaction(async (tx) => {
    // Match individual checkout creation: hold scheduling before any appointment row lock.
    // Existing receipts are read here. Payment locks them separately after review.
    await lockScheduling(tx);
    const [anchor] = await tx
      .select({ booking: appointment, itineraryId: appointmentVisitPart.visitId })
      .from(appointment)
      .leftJoin(appointmentVisitPart, eq(appointmentVisitPart.appointmentId, appointment.id))
      .where(and(eq(appointment.id, appointmentId), isNull(appointment.deletedAt)));
    const groupId = anchor?.itineraryId ?? anchor?.booking.visitGroupId;
    if (!anchor || !groupId) throw new DomainError("not_found", "Visit not found");

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
          .orderBy(asc(appointment.startsAt), asc(appointment.id))
          .limit(maxVisitAppointments + 1);

    if (
      rows.some(
        ({ booking }) =>
          booking.clientId !== anchor.booking.clientId ||
          ((!permissions.allSales || !permissions.allCalendars) &&
            booking.staffId !== principal.staffId),
      )
    )
      throw new DomainError("not_found", "Visit not found");
    if (rows.length < 2 || rows.length > maxVisitAppointments)
      throw new DomainError("invalid_state", "Visit requires between 2 and 24 appointments");

    const billableIds = rows
      .filter(({ booking }) => booking.status !== "cancelled")
      .map(({ booking }) => booking.id);
    if ((await appointmentBillingHolds(tx, billableIds)).size)
      throw new DomainError(
        "invalid_state",
        "Review the imported charges before preparing this visit",
      );

    const appointments: VisitCheckout["appointments"] = [];
    for (const { booking } of rows) {
      let receipt: VisitCheckout["appointments"][number]["receipt"] = null;
      if (booking.status !== "cancelled") {
        receipt = await createCheckoutInTransaction(
          tx,
          {
            appointmentId: booking.id,
            currency: "EUR",
            lines: [],
            discountCents: 0,
            tipCents: 0,
            idempotencyKey: crypto.randomUUID(),
          },
          principal,
        );
      }
      appointments.push({
        appointmentId: booking.id,
        staffId: booking.staffId,
        startsAt: booking.startsAt.toISOString(),
        receipt,
      });
    }
    return { groupId, source: anchor.itineraryId ? "itinerary" : "import", appointments };
  });
}
