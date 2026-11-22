import type { ReportQuery, ReportStaffWorkPeriod, StaffOccupancy } from "@sob/contracts";
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

type VisitInterval = Interval & { status: "completed" | "no_show" };
const rate = (reserved: number, available: number) =>
  available ? Math.round((reserved / available) * 10_000) / 10_000 : null;

function measureOccupancy(
  period: Interval,
  shifts: Interval[],
  blocks: Interval[],
  appointments: Interval[],
  visits: VisitInterval[],
) {
  const dayShifts = intersection([period], shifts);
  const blocked = intersection(dayShifts, blocks);
  const reserved = intersection(dayShifts, appointments);
  const visitTime = { completed: 0, no_show: 0 };
  for (const visit of visits) {
    visitTime[visit.status] += Math.max(
      0,
      Math.min(period.end, visit.end) - Math.max(period.start, visit.start),
    );
  }
  const scheduledTime = duration(dayShifts);
  const blockedTime = duration(blocked);
  const availableTime = scheduledTime - blockedTime;
  const reservedTime = duration(reserved) - duration(intersection(reserved, blocked));
  const summary: StaffOccupancy = {
    scheduledMinutes: minutes(scheduledTime),
    blockedMinutes: minutes(blockedTime),
    reservedMinutes: minutes(reservedTime),
    completedMinutes: minutes(visitTime.completed),
    noShowMinutes: minutes(visitTime.no_show),
    occupancyRate: rate(reservedTime, availableTime),
  };
  return { summary, availableTime, reservedTime };
}

function dailyPeriods(from: string, to: string, timezone: string) {
  const windows = [];
  const finish = Temporal.PlainDate.from(to);
  let current = Temporal.PlainDate.from(from);
  let start = current.toZonedDateTime(timezone).epochMilliseconds;
  while (Temporal.PlainDate.compare(current, finish) <= 0) {
    const next = current.add({ days: 1 });
    const end = next.toZonedDateTime(timezone).epochMilliseconds;
    windows.push({ date: current.toString(), start, end });
    current = next;
    start = end;
  }
  return windows;
}

export async function reportStaffOccupancy(
  db: Tx,
  staffIds: string[],
  query: ReportQuery,
  { timezone, fromAt, toAt }: { timezone: string; fromAt: string; toAt: string },
  detailStaffId?: string,
): Promise<{
  byStaff: Map<string, StaffOccupancy>;
  rate: number | null;
  detail?: ReportStaffWorkPeriod;
}> {
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
  const period = { start: from.getTime(), end: to.getTime() };
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
  let detail: ReportStaffWorkPeriod | undefined;
  const occupancyByStaff = new Map(
    staffIds.map((staffId) => {
      const shifts = union(shiftsByStaff.get(staffId) ?? []);
      const blocks = merged(blocksByStaff.get(staffId) ?? []);
      const reserved = merged(reservationsByStaff.get(staffId) ?? []);
      const visits = (visitsByStaff.get(staffId) ?? []).flatMap(
        ({ status, start, end }): VisitInterval[] =>
          status === "completed" || status === "no_show"
            ? [{ status, start: start.getTime(), end: end.getTime() }]
            : [],
      );
      const measured = measureOccupancy(period, shifts, blocks, reserved, visits);
      totalAvailable += measured.availableTime;
      totalReserved += measured.reservedTime;
      if (detailStaffId === staffId) {
        detail = {
          from: query.from,
          to: query.to,
          totals: measured.summary,
          days: dailyPeriods(query.from, query.to, timezone).map(({ date, ...window }) => ({
            date,
            ...measureOccupancy(window, shifts, blocks, reserved, visits).summary,
          })),
          unavailable: intersection([period], blocks).map(({ start, end }) => ({
            startsAt: new Date(start).toISOString(),
            endsAt: new Date(end).toISOString(),
          })),
        };
      }
      return [staffId, measured.summary];
    }),
  );
  return { byStaff: occupancyByStaff, rate: rate(totalReserved, totalAvailable), detail };
}
