import { appointment, appointmentService, resourceReservation, waitlistOffer } from "@sob/db";
import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import type { Tx } from "../../tx";
import { repackFutureResources, reserveResources, type TimedService } from "./reservations";
/** The scheduling lock is held. Lock every affected parent before touching its child rows, including before new FK checks. */
export async function reconfigureScheduledResources(tx: Tx, serviceId: string, now: Date) {
  const appointments = await tx
    .select()
    .from(appointment)
    .where(
      and(
        eq(appointment.status, "booked"),
        isNull(appointment.deletedAt),
        gt(appointment.startsAt, now),
        sql`exists (select 1 from appointment_service s where s.appointment_id=${appointment.id} and s.service_id=${serviceId})`,
      ),
    )
    .orderBy(asc(appointment.id))
    .for("update");
  const offers = await tx
    .select()
    .from(waitlistOffer)
    .where(
      and(
        eq(waitlistOffer.state, "offered"),
        gt(waitlistOffer.expiresAt, now),
        // Entry selections are immutable normalized UUID arrays. Filter through them
        // without locking entries or depending on the driver's JSON wire encoding.
        sql`exists (select 1 from waitlist_entry e where e.id=${waitlistOffer.entryId} and ${serviceId}::uuid=any(e.service_ids))`,
      ),
    )
    .orderBy(asc(waitlistOffer.id))
    .for("update");
  if (!appointments.length && !offers.length) return { appointments: 0, offers: 0 };
  const snapshots = appointments.length
    ? await tx
        .select()
        .from(appointmentService)
        .where(
          inArray(
            appointmentService.appointmentId,
            appointments.map((a) => a.id),
          ),
        )
        .orderBy(asc(appointmentService.position))
    : [];
  const changed: { appointmentId?: string; offerId?: string; position: number }[] = [];
  for (const booking of appointments)
    for (const s of snapshots.filter(
      (s) => s.appointmentId === booking.id && s.serviceId === serviceId,
    ))
      changed.push({ appointmentId: booking.id, position: s.position });
  for (const offer of offers)
    for (const [position, s] of offer.services.entries())
      if (s.id === serviceId) changed.push({ offerId: offer.id, position });
  if (changed.length)
    await tx
      .delete(resourceReservation)
      .where(
        or(
          ...changed.map((c) =>
            and(
              c.appointmentId
                ? eq(resourceReservation.appointmentId, c.appointmentId)
                : eq(resourceReservation.offerId, c.offerId ?? ""),
              eq(resourceReservation.servicePosition, c.position),
            ),
          ),
        ),
      );
  for (const booking of appointments) {
    const services: TimedService[] = snapshots
      .filter((s) => s.appointmentId === booking.id)
      .map((s) => ({
        id: s.serviceId ?? s.id,
        position: s.position,
        durationMinutes: s.durationMinutes,
        bufferMinutes: s.bufferMinutes,
      }));
    await reserveResources(
      tx,
      { appointmentId: booking.id, startsAt: booking.startsAt, endsAt: booking.endsAt },
      services,
      now,
      { onlyServiceId: serviceId, repackRaw: true },
    );
  }
  for (const offer of offers)
    await reserveResources(
      tx,
      { offerId: offer.id, startsAt: offer.startsAt, endsAt: offer.endsAt },
      offer.services,
      now,
      { onlyServiceId: serviceId, repackRaw: true },
    );
  const ids = await tx
    .selectDistinct({ id: resourceReservation.resourceId })
    .from(resourceReservation)
    .where(
      or(
        appointments.length
          ? inArray(
              resourceReservation.appointmentId,
              appointments.map((a) => a.id),
            )
          : undefined,
        offers.length
          ? inArray(
              resourceReservation.offerId,
              offers.map((o) => o.id),
            )
          : undefined,
      ),
    );
  if (appointments.length || offers.length)
    await repackFutureResources(
      tx,
      ids.map((r) => r.id),
      now,
    );
  return { appointments: appointments.length, offers: offers.length };
}
