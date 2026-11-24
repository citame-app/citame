import { createCheckoutSchema, type VisitCheckout } from "@sob/contracts";
import { appointment, appointmentVisitPart, type Database } from "@sob/db";
import { and, asc, eq, isNull } from "drizzle-orm";
import { canReviewVisitCheckouts } from "../../auth/policy";
import type { Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import { lockScheduling } from "../../tx";
import { appointmentBillingHolds, externallySettledAppointments } from "./appointment-billing";
import { createCheckoutInTransaction, readAppointmentCheckout, requireOperator } from "./service";

export async function prepareVisitCheckouts(
  db: Database,
  appointmentId: string,
  principal: Principal,
): Promise<VisitCheckout> {
  requireOperator(principal);
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

    if (
      rows.some(({ booking }) => booking.clientId !== anchor.booking.clientId) ||
      !canReviewVisitCheckouts(
        principal,
        rows.map(({ booking }) => booking.staffId),
      )
    )
      throw new DomainError("not_found", "Visit not found");
    if (rows.length < 2)
      throw new DomainError("invalid_state", "Visit requires at least two appointments");

    const settled = await externallySettledAppointments(
      tx,
      rows.map(({ booking }) => booking.id),
    );
    const billableIds = rows.flatMap(({ booking }) =>
      booking.status === "cancelled" || settled.has(booking.id) ? [] : [booking.id],
    );
    if ((await appointmentBillingHolds(tx, billableIds)).size)
      throw new DomainError(
        "invalid_state",
        "Review the imported charges before preparing this visit",
      );

    const appointments: VisitCheckout["appointments"] = [];
    for (const { booking } of rows) {
      const settledExternally = settled.has(booking.id);
      const receipt =
        booking.status === "cancelled" || settledExternally
          ? await readAppointmentCheckout(tx, booking.id, principal)
          : await createCheckoutInTransaction(
              tx,
              createCheckoutSchema.parse({
                appointmentId: booking.id,
                idempotencyKey: crypto.randomUUID(),
              }),
              principal,
            );
      appointments.push({
        appointmentId: booking.id,
        staffId: booking.staffId,
        startsAt: booking.startsAt.toISOString(),
        status: booking.status,
        settledExternally,
        receipt,
      });
    }
    return { groupId, source: anchor.itineraryId ? "itinerary" : "import", appointments };
  });
}
