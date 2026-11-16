import { type CreateAppointmentRequest, intakeBookingIdentity } from "@sob/contracts";
import { appointment, auditLog, type Database } from "@sob/db";
import { and, eq, isNull } from "drizzle-orm";
import { DomainError } from "../../errors";
import { protectionView } from "../booking-protection/value";
import { appointmentIntentFingerprint } from "./intent";
import { loadBookingPrices } from "./pricing";
import { loadSeriesReferences } from "./series-references";
import { loadSnapshots, toAppointment } from "./service";

/** Call only after the create policy has scoped the request to the authenticated actor. */
export async function findAppointmentReplay(
  db: Database,
  request: CreateAppointmentRequest,
  actorUserId: string,
) {
  if (!request.id) return null;
  const [row] = await db
    .select()
    .from(appointment)
    .where(and(eq(appointment.id, request.id), isNull(appointment.deletedAt)));
  // Never return a visit that has moved out of the authorized request's calendar/client.
  if (
    !row ||
    row.staffId !== request.staffId ||
    row.startsAt.getTime() !== Date.parse(request.startsAt) ||
    (request.clientId && row.clientId !== request.clientId)
  )
    return null;
  const [created] = await db
    .select({ metadata: auditLog.metadata })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entity, "appointment"),
        eq(auditLog.entityId, row.id),
        eq(auditLog.action, "appointment.create"),
        eq(auditLog.actorUserId, actorUserId),
      ),
    )
    .limit(1);
  if (!created) return null;
  const snapshots = ((await loadSnapshots(db, [row.id])).get(row.id) ?? []).sort(
    (a, b) => a.position - b.position,
  );
  if (created.metadata.requestFingerprint !== undefined) {
    if (created.metadata.requestFingerprint !== appointmentIntentFingerprint(request)) {
      if (
        created.metadata.intakeConfirmed ||
        intakeBookingIdentity(request) ||
        created.metadata.promotionConfirmed ||
        request.promotion
      )
        throw new DomainError(
          "booking_intent_conflict",
          "This booking identifier already contains a different confirmed statement",
        );
      return null;
    }
  } else if (
    !request.clientId ||
    row.notes !== (request.notes ?? null) ||
    JSON.stringify(snapshots.map((s) => s.serviceId)) !==
      JSON.stringify([...new Set(request.serviceIds)])
  )
    return null;
  const series = (await loadSeriesReferences(db, [row.id])).get(row.id);
  const bookingPrice = (await loadBookingPrices(db, [row.id])).get(row.id);
  return {
    ...toAppointment(row, snapshots, series),
    protection: await protectionView(db, row.id),
    ...(bookingPrice ? { bookingPrice } : {}),
  };
}
