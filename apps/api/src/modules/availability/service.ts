import type { AvailabilityQuery, AvailabilityResponse } from "@sob/contracts";
import { appointment, type Database, timeOff, waitlistOffer, workingHours } from "@sob/db";
import { and, eq, gt, inArray, isNull, lt, ne } from "drizzle-orm";
import { getServicesByIds } from "../services/service";
import { getSalonSettings } from "../settings/service";
import { assertStaffExists, staffQualifiedFor } from "../staff/service";
import { computeAvailability, totalBlockMinutes } from "./compute";

/** Finds bookable slots. Advisory only: the database exclusion constraint is authoritative. */
export async function findAvailability(
  db: Database,
  query: AvailabilityQuery,
  now: Date,
): Promise<AvailabilityResponse> {
  const settings = await getSalonSettings(db);
  const services = await getServicesByIds(db, query.serviceIds);
  if (query.staffId) await assertStaffExists(db, query.staffId);

  let staffIds = await staffQualifiedFor(
    db,
    services.map((s) => s.id),
  );
  if (query.staffId) staffIds = staffIds.filter((id) => id === query.staffId);

  const base = { date: query.date, timezone: settings.timezone };
  if (staffIds.length === 0) return { ...base, slots: [] };

  const dayStart = Temporal.PlainDate.from(query.date).toZonedDateTime(settings.timezone);
  const windowStart = new Date(dayStart.epochMilliseconds);
  const windowEnd = new Date(dayStart.add({ days: 1 }).epochMilliseconds);

  const [hours, offs, offered, booked] = await Promise.all([
    db
      .select()
      .from(workingHours)
      .where(and(inArray(workingHours.staffId, staffIds), isNull(workingHours.deletedAt))),
    db
      .select()
      .from(timeOff)
      .where(
        and(
          inArray(timeOff.staffId, staffIds),
          isNull(timeOff.deletedAt),
          lt(timeOff.startsAt, windowEnd),
          gt(timeOff.endsAt, windowStart),
        ),
      ),
    db
      .select()
      .from(waitlistOffer)
      .where(
        and(
          inArray(waitlistOffer.staffId, staffIds),
          eq(waitlistOffer.state, "offered"),
          gt(waitlistOffer.expiresAt, now),
          lt(waitlistOffer.startsAt, windowEnd),
          gt(waitlistOffer.endsAt, windowStart),
        ),
      ),
    db
      .select()
      .from(appointment)
      .where(
        and(
          inArray(appointment.staffId, staffIds),
          ne(appointment.status, "cancelled"),
          isNull(appointment.deletedAt),
          lt(appointment.startsAt, windowEnd),
          gt(appointment.endsAt, windowStart),
        ),
      ),
  ]);

  const slots = computeAvailability({
    date: query.date,
    timeZone: settings.timezone,
    granularityMinutes: settings.slotGranularityMinutes,
    minNoticeMinutes: settings.minNoticeMinutes,
    maxDaysAhead: settings.maxDaysAhead,
    now,
    blockMinutes: totalBlockMinutes(services),
    staff: staffIds.map((staffId) => ({
      staffId,
      workingHours: hours
        .filter((h) => h.staffId === staffId)
        .map((h) => ({ weekday: h.weekday, start: h.startTime, end: h.endTime })),
      timeOff: offs
        .filter((o) => o.staffId === staffId)
        .map((o) => ({ start: o.startsAt, end: o.endsAt })),
      appointments: [...booked, ...offered]
        .filter((a) => a.staffId === staffId)
        .map((a) => ({ start: a.startsAt, end: a.endsAt })),
    })),
  });

  return {
    ...base,
    slots: slots.map((s) => ({
      staffId: s.staffId,
      startsAt: s.startsAt.toISOString(),
      endsAt: s.endsAt.toISOString(),
    })),
  };
}
