import type { ReportQuery, StaffOccupancy } from "@sob/contracts";
import { appointment, staffReservation, timeOff, workingHours } from "@sob/db";
import { and, eq, gt, inArray, isNull, lt } from "drizzle-orm";
import type { Tx } from "../../tx";
import { workingWindows } from "../availability/windows";
import { asDatedHours, byStaff, loadShiftRows } from "../staff/date-hours";

interface Interval {
  start: number;
  end: number;
}

function union(intervals: Interval[]): Interval[] {
  const ordered = intervals.filter((range) => range.start < range.end);
  ordered.sort((left, right) => left.start - right.start);
  const merged: Interval[] = [];
  for (const range of ordered) {
    const last = merged.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/** Inputs are sorted and disjoint. Advance whichever range ends first. */
function intersection(left: Interval[], right: Interval[]): Interval[] {
  const result: Interval[] = [];
  let index = 0;
  for (const range of left) {
    while (index < right.length) {
      const other = right[index]!;
      if (other.start >= range.end) break;
      const start = Math.max(range.start, other.start);
      const end = Math.min(range.end, other.end);
      if (start < end) result.push({ start, end });
      if (other.end > range.end) break;
      index++;
    }
  }
  return result;
}

const duration = (ranges: Interval[]) =>
  ranges.reduce((total, range) => total + range.end - range.start, 0);
const minutes = (milliseconds: number) => Math.round(milliseconds / 60_000);

export async function reportStaffOccupancy(
  db: Tx,
  staffIds: string[],
  query: ReportQuery,
  { timezone, fromAt, toAt }: { timezone: string; fromAt: string; toAt: string },
): Promise<{ byStaff: Map<string, StaffOccupancy>; rate: number | null }> {
  if (!staffIds.length) return { byStaff: new Map(), rate: null };
  const from = new Date(fromAt);
  const to = new Date(toAt);
  const [hours, dated, blocks, visits, reservations] = await Promise.all([
    db
      .select()
      .from(workingHours)
      .where(and(inArray(workingHours.staffId, staffIds), isNull(workingHours.deletedAt))),
    loadShiftRows(db, staffIds, query.from, query.to),
    db
      .select({ staffId: timeOff.staffId, start: timeOff.startsAt, end: timeOff.endsAt })
      .from(timeOff)
      .where(
        and(
          inArray(timeOff.staffId, staffIds),
          isNull(timeOff.deletedAt),
          lt(timeOff.startsAt, to),
          gt(timeOff.endsAt, from),
        ),
      ),
    db
      .select({
        staffId: appointment.staffId,
        status: appointment.status,
        start: appointment.startsAt,
        end: appointment.endsAt,
      })
      .from(appointment)
      .where(
        and(
          inArray(appointment.staffId, staffIds),
          isNull(appointment.deletedAt),
          inArray(appointment.status, ["completed", "no_show"]),
          lt(appointment.startsAt, to),
          gt(appointment.endsAt, from),
        ),
      ),
    db
      .select({
        staffId: staffReservation.staffId,
        start: staffReservation.startsAt,
        end: staffReservation.endsAt,
      })
      .from(staffReservation)
      .innerJoin(appointment, eq(appointment.id, staffReservation.appointmentId))
      .where(
        and(
          inArray(staffReservation.staffId, staffIds),
          eq(staffReservation.active, true),
          isNull(appointment.deletedAt),
          inArray(appointment.status, ["booked", "completed"]),
          lt(staffReservation.startsAt, to),
          gt(staffReservation.endsAt, from),
        ),
      ),
  ]);
  const period = [{ start: from.getTime(), end: to.getTime() }];
  const weekly = byStaff(hours);
  const datedByStaff = byStaff(dated);
  const schedule = workingWindows({
    from,
    to,
    timeZone: timezone,
    staff: staffIds.map((staffId) => ({
      staffId,
      workingHours: (weekly.get(staffId) ?? []).map((row) => ({
        weekday: row.weekday,
        start: row.startTime,
        end: row.endTime,
      })),
      datedWorkingHours: asDatedHours(datedByStaff.get(staffId) ?? []),
    })),
  });
  const shiftsByStaff = byStaff(
    schedule.map(({ staffId, startsAt, endsAt }) => ({
      staffId,
      start: startsAt.getTime(),
      end: endsAt.getTime(),
    })),
  );
  const blocksByStaff = byStaff(blocks);
  const reservationsByStaff = byStaff(reservations);
  const visitsByStaff = byStaff(visits);
  const merged = (items: { start: Date; end: Date }[]) =>
    union(items.map(({ start, end }) => ({ start: start.getTime(), end: end.getTime() })));
  let totalAvailable = 0;
  let totalReserved = 0;
  const rate = (reserved: number, available: number) =>
    available ? Math.round((reserved / available) * 10_000) / 10_000 : null;
  const occupancyByStaff = new Map(
    staffIds.map((staffId) => {
      const shifts = intersection(period, union(shiftsByStaff.get(staffId) ?? []));
      const blocked = intersection(shifts, merged(blocksByStaff.get(staffId) ?? []));
      const reserved = intersection(shifts, merged(reservationsByStaff.get(staffId) ?? []));
      const visitTime = { completed: 0, no_show: 0 };
      for (const visit of visitsByStaff.get(staffId) ?? []) {
        if (visit.status === "completed" || visit.status === "no_show") {
          visitTime[visit.status] +=
            Math.min(to.getTime(), visit.end.getTime()) -
            Math.max(from.getTime(), visit.start.getTime());
        }
      }
      const scheduledTime = duration(shifts);
      const blockedTime = duration(blocked);
      const availableTime = scheduledTime - blockedTime;
      const reservedTime = duration(reserved) - duration(intersection(reserved, blocked));
      totalAvailable += availableTime;
      totalReserved += reservedTime;
      return [
        staffId,
        {
          scheduledMinutes: minutes(scheduledTime),
          blockedMinutes: minutes(blockedTime),
          reservedMinutes: minutes(reservedTime),
          completedMinutes: minutes(visitTime.completed),
          noShowMinutes: minutes(visitTime.no_show),
          occupancyRate: rate(reservedTime, availableTime),
        },
      ];
    }),
  );
  return { byStaff: occupancyByStaff, rate: rate(totalReserved, totalAvailable) };
}
