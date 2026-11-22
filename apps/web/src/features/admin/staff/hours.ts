import type { WorkingRange } from "@sob/contracts";
import { zonedInstant } from "~/lib/zoned";

export interface TimeRange {
  start: string;
  end: string;
}
/** Weekday (0 = Sunday) to that day's ranges. */
export type WeekHours = Record<number, TimeRange[]>;

export { WEEKDAY_ORDER } from "~/lib/format";

export function emptyWeek(): WeekHours {
  return { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
}

export function fromRanges(ranges: WorkingRange[]): WeekHours {
  const week = emptyWeek();
  for (const r of ranges) week[r.weekday]?.push({ start: r.startTime, end: r.endTime });
  for (const day of Object.values(week)) day.sort((a, b) => a.start.localeCompare(b.start));
  return week;
}

export function toRanges(week: WeekHours): WorkingRange[] {
  return Object.entries(week)
    .flatMap(([weekday, ranges]) =>
      ranges.map((r) => ({ weekday: Number(weekday), startTime: r.start, endTime: r.end })),
    )
    .sort((a, b) => a.weekday - b.weekday || a.startTime.localeCompare(b.startTime));
}

export function copyDay(week: WeekHours, from: number, targets: number[]): WeekHours {
  const next: WeekHours = { ...week };
  for (const target of targets) next[target] = (week[from] ?? []).map((r) => ({ ...r }));
  return next;
}

export function addRange(day: TimeRange[]): TimeRange[] {
  const last = day[day.length - 1];
  if (!last) return [{ start: "09:00", end: "18:00" }];
  const hour = Number(last.end.slice(0, 2));
  const start = `${String(Math.min(hour + 1, 22)).padStart(2, "0")}:${last.end.slice(3)}`;
  return [...day, { start, end: "18:00" > start ? "18:00" : "23:00" }];
}

export interface DayIssue {
  index: number;
  kind: "order" | "overlap";
}

export function validateDay(day: TimeRange[]): DayIssue[] {
  const issues: DayIssue[] = [];
  day.forEach((range, index) => {
    if (range.start >= range.end) issues.push({ index, kind: "order" });
  });
  const sorted = day
    .map((range, index) => ({ ...range, index }))
    .sort((a, b) => a.start.localeCompare(b.start));
  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1];
    const current = sorted[i];
    if (previous && current && current.start < previous.end)
      issues.push({ index: current.index, kind: "overlap" });
  }
  return issues;
}

export function weekIsValid(week: WeekHours): boolean {
  return Object.values(week).every((day) => validateDay(day).length === 0);
}

export function hoursEqual(a: WeekHours, b: WeekHours): boolean {
  return JSON.stringify(toRanges(a)) === JSON.stringify(toRanges(b));
}

export interface TimeOffForm {
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
}

export type ZonedTimeOff =
  | { ok: true; startsAt: string; endsAt: string }
  | { ok: false; error: "required" | "endBeforeStart" };

export function zonedTimeOff(form: TimeOffForm, timeZone: string): ZonedTimeOff {
  if (!form.startDate || !form.startTime || !form.endDate || !form.endTime)
    return { ok: false, error: "required" };
  const startsAt = zonedInstant(form.startDate, form.startTime, timeZone);
  const endsAt = zonedInstant(form.endDate, form.endTime, timeZone);
  if (Date.parse(endsAt) <= Date.parse(startsAt)) return { ok: false, error: "endBeforeStart" };
  return { ok: true, startsAt, endsAt };
}
