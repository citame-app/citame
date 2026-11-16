/**
 * Pure booking-window rules shared by the booking endpoint and the schedule-conflict report.
 * Like `compute.ts` there is no I/O or clock access: `now` and the salon timezone come in.
 */
import { resolveWorkingRange } from "./compute";
import { type DatedWorkingHours, hoursForDate } from "./dated-hours";

const MS_PER_MINUTE = 60_000;

export type BookingViolation =
  | "max_days_ahead"
  | "outside_working_hours"
  | "time_off"
  | "min_notice";

export interface WeeklyRange {
  /** 0 = Sunday ... 6 = Saturday. */
  weekday: number;
  /** `HH:MM` or `HH:MM:SS` salon-local wall-clock time. */
  start: string;
  end: string;
}

export interface Interval {
  start: Date;
  end: Date;
}

export interface WindowInput {
  startsAt: Date;
  endsAt: Date;
  timeZone: string;
  now: Date;
  minNoticeMinutes: number;
  maxDaysAhead: number;
  workingHours: WeeklyRange[];
  datedWorkingHours?: DatedWorkingHours[];
  timeOff: Interval[];
}

const toZoned = (date: Date, timeZone: string) =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime()).toZonedDateTimeISO(timeZone);

/**
 * True when [startsAt, endsAt) lies inside the staff member's working hours of the salon-local
 * day it starts on. Ranges that touch (13:00 end, 13:00 start) form one continuous range, so a
 * booking can cross between them, but a real gap (a lunch break) cannot be crossed.
 */
function fitsWorkingHours(
  startsAt: Date,
  endsAt: Date,
  timeZone: string,
  workingHours: WeeklyRange[],
  datedWorkingHours?: DatedWorkingHours[],
): boolean {
  const date = toZoned(startsAt, timeZone).toPlainDate();
  const weekday = date.dayOfWeek % 7; // Temporal: 1 = Monday ... 7 = Sunday
  const ranges = hoursForDate(date, workingHours, datedWorkingHours)
    .filter((h) => h.weekday === weekday)
    .map((h) => resolveWorkingRange(date, timeZone, h))
    .sort((a, b) => a.startMs - b.startMs);

  const merged: { startMs: number; endMs: number }[] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range.startMs <= last.endMs) last.endMs = Math.max(last.endMs, range.endMs);
    else merged.push({ ...range });
  }
  return merged.some(
    (range) => range.startMs <= startsAt.getTime() && endsAt.getTime() <= range.endMs,
  );
}

const overlapsAny = (startsAt: Date, endsAt: Date, intervals: Interval[]) =>
  intervals.some(
    (i) => startsAt.getTime() < i.end.getTime() && endsAt.getTime() > i.start.getTime(),
  );

/** Every rule the requested window breaks, in a stable order. Empty means bookable. */
export function bookingViolations(input: WindowInput): BookingViolation[] {
  const { startsAt, endsAt, timeZone, now } = input;
  const violations: BookingViolation[] = [];

  const today = toZoned(now, timeZone).toPlainDate();
  const startDate = toZoned(startsAt, timeZone).toPlainDate();
  const daysAhead = today.until(startDate, { largestUnit: "days" }).days;
  if (daysAhead > input.maxDaysAhead) violations.push("max_days_ahead");

  if (!fitsWorkingHours(startsAt, endsAt, timeZone, input.workingHours, input.datedWorkingHours)) {
    violations.push("outside_working_hours");
  }
  if (overlapsAny(startsAt, endsAt, input.timeOff)) violations.push("time_off");
  if (startsAt.getTime() < now.getTime() + input.minNoticeMinutes * MS_PER_MINUTE) {
    violations.push("min_notice");
  }
  return violations;
}

export type ConflictReason = "outside_working_hours" | "time_off";

export interface ConflictInput {
  appointments: { id: string; status: string; startsAt: Date; endsAt: Date }[];
  workingHours: WeeklyRange[];
  datedWorkingHours?: DatedWorkingHours[];
  timeOff: Interval[];
  timeZone: string;
  now: Date;
}

export interface ScheduleConflict {
  id: string;
  reasons: ConflictReason[];
}

/**
 * Appointments that are still ahead of us and no longer fit the given schedule. Cancelled and
 * finished appointments are never conflicts. Input order is preserved.
 */
export function findConflicts(input: ConflictInput): ScheduleConflict[] {
  const conflicts: ScheduleConflict[] = [];
  for (const a of input.appointments) {
    if (a.status === "cancelled" || a.endsAt.getTime() <= input.now.getTime()) continue;
    const reasons: ConflictReason[] = [];
    if (
      !fitsWorkingHours(
        a.startsAt,
        a.endsAt,
        input.timeZone,
        input.workingHours,
        input.datedWorkingHours,
      )
    ) {
      reasons.push("outside_working_hours");
    }
    if (overlapsAny(a.startsAt, a.endsAt, input.timeOff)) reasons.push("time_off");
    if (reasons.length > 0) conflicts.push({ id: a.id, reasons });
  }
  return conflicts;
}
