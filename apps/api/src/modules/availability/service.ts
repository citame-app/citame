import type { AvailabilityQuery, AvailabilityResponse } from "@sob/contracts";
import { type Database, staffProfile, timeOff, workingHours } from "@sob/db";
import { and, gt, inArray, isNull, lt } from "drizzle-orm";
import type { Tx } from "../../tx";
import type { TimedService } from "../resources/reservations";
import { filterResourceAvailability } from "../resources/reservations";
import { getBookableServices } from "../services/service";
import { getSalonSettings } from "../settings/service";
import { asDatedHours, loadShiftRows } from "../staff/date-hours";
import { assertStaffExists, staffQualifiedFor } from "../staff/service";
import { computeAvailability, totalBlockMinutes } from "./compute";
import { staffOccupied } from "./staff-reservations";
import { serviceWorkWindows } from "./work-windows";

/** Finds bookable slots. Advisory only: the database exclusion constraint is authoritative. */
export async function findAvailability(
  db: Database | Tx,
  query: AvailabilityQuery,
  now: Date,
  options: { excludeAppointmentId?: string; services?: TimedService[] } = {},
): Promise<AvailabilityResponse> {
  const settings = await getSalonSettings(db);
  const services = options.services ?? (await getBookableServices(db, query.serviceIds));
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

  const [hours, offs, busy, members, dated] = await Promise.all([
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
    staffOccupied(db, staffIds, windowStart, windowEnd, now, options.excludeAppointmentId),
    db
      .select({ id: staffProfile.id, capacity: staffProfile.maxConcurrent })
      .from(staffProfile)
      .where(inArray(staffProfile.id, staffIds)),
    loadShiftRows(db, staffIds, query.date, query.date),
  ]);

  const computed = computeAvailability({
    date: query.date,
    timeZone: settings.timezone,
    granularityMinutes: settings.slotGranularityMinutes,
    minNoticeMinutes: settings.minNoticeMinutes,
    maxDaysAhead: settings.maxDaysAhead,
    now,
    blockMinutes: totalBlockMinutes(services),
    workWindows: serviceWorkWindows(services),
    staff: staffIds.map((staffId) => ({
      staffId,
      capacity: members.find((s) => s.id === staffId)?.capacity ?? 1,
      datedWorkingHours: asDatedHours(dated, staffId),
      workingHours: hours
        .filter((h) => h.staffId === staffId)
        .map((h) => ({ weekday: h.weekday, start: h.startTime, end: h.endTime })),
      timeOff: offs
        .filter((o) => o.staffId === staffId)
        .map((o) => ({ start: o.startsAt, end: o.endsAt })),
      appointments: busy
        .filter((a) => a.staffId === staffId)
        .map((a) => ({ start: a.startsAt, end: a.endsAt })),
    })),
  });

  const slots = await filterResourceAvailability(
    db,
    services,
    computed,
    now,
    options.excludeAppointmentId,
  );
  return {
    ...base,
    slots: slots.map((s) => ({
      staffId: s.staffId,
      startsAt: s.startsAt.toISOString(),
      endsAt: s.endsAt.toISOString(),
    })),
  };
}
