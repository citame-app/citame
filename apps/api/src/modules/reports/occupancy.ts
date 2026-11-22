import type { ReportQuery, StaffOccupancy } from "@sob/contracts";
import { appointment, staffReservation, timeOff, workingHours } from "@sob/db";
import { and, eq, gt, inArray, isNull, lt } from "drizzle-orm";
import type { Tx } from "../../tx";
import { resolveWorkingRange } from "../availability/compute";
import { hoursForDate } from "../availability/dated-hours";
import { asDatedHours, loadShiftRows } from "../staff/date-hours";

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
): Promise<Map<string, StaffOccupancy>> {
  if (!staffIds.length) return new Map();
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
  const days: Temporal.PlainDate[] = [];
  for (
    let day = Temporal.PlainDate.from(query.from);
    day.toString() <= query.to;
    day = day.add({ days: 1 })
  ) {
    days.push(day);
  }
  const ranges = (items: { staffId: string; start: Date; end: Date }[], staffId: string) =>
    intersection(
      period,
      union(
        items
          .filter((item) => item.staffId === staffId)
          .map((item) => ({ start: item.start.getTime(), end: item.end.getTime() })),
      ),
    );
  const completed = visits.filter((visit) => visit.status === "completed");
  const noShows = visits.filter((visit) => visit.status === "no_show");
  return new Map(
    staffIds.map((staffId) => {
      const weekly = hours
        .filter((row) => row.staffId === staffId)
        .map((row) => ({ weekday: row.weekday, start: row.startTime, end: row.endTime }));
      const overrides = asDatedHours(dated, staffId);
      const shifts = intersection(
        period,
        union(
          days.flatMap((day) =>
            hoursForDate(day, weekly, overrides)
              .filter((range) => range.weekday === day.dayOfWeek % 7)
              .map((range) => {
                const { startMs, endMs } = resolveWorkingRange(day, timezone, range);
                return { start: startMs, end: endMs };
              }),
          ),
        ),
      );
      const blocked = intersection(shifts, ranges(blocks, staffId));
      const reserved = intersection(shifts, ranges(reservations, staffId));
      const scheduledTime = duration(shifts);
      const blockedTime = duration(blocked);
      const availableTime = scheduledTime - blockedTime;
      const reservedTime = duration(reserved) - duration(intersection(reserved, blocked));
      return [
        staffId,
        {
          scheduledMinutes: minutes(scheduledTime),
          blockedMinutes: minutes(blockedTime),
          reservedMinutes: minutes(reservedTime),
          completedMinutes: minutes(duration(ranges(completed, staffId))),
          noShowMinutes: minutes(duration(ranges(noShows, staffId))),
          occupancyRate: availableTime
            ? Math.round((reservedTime / availableTime) * 10_000) / 10_000
            : null,
        },
      ];
    }),
  );
}
