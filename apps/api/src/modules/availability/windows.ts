import { resolveWorkingRange } from "./compute";
import { type DatedWorkingHours, hoursForDate } from "./dated-hours";
import type { WeeklyRange } from "./rules";

export interface WindowsInput {
  from: Date;
  to: Date;
  timeZone: string;
  staff: {
    staffId: string;
    workingHours: WeeklyRange[];
    datedWorkingHours?: DatedWorkingHours[];
  }[];
}

export interface ResolvedWindow {
  staffId: string;
  startsAt: Date;
  endsAt: Date;
}

const localDate = (date: Date, timeZone: string) =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime()).toZonedDateTimeISO(timeZone).toPlainDate();

/**
 * Expands recurring weekly hours into the concrete blocks that overlap [from, to), as absolute
 * instants. Each local date is resolved through the timezone database, so a DST change moves
 * the instants but never the wall-clock hours. Blocks keep their full length even when the
 * range cuts through them, so a calendar can draw them from their real start.
 */
export function workingWindows(input: WindowsInput): ResolvedWindow[] {
  const { from, to, timeZone } = input;
  const windows: ResolvedWindow[] = [];
  const last = localDate(to, timeZone);

  for (
    let date = localDate(from, timeZone);
    Temporal.PlainDate.compare(date, last) <= 0;
    date = date.add({ days: 1 })
  ) {
    const weekday = date.dayOfWeek % 7; // Temporal: 1 = Monday ... 7 = Sunday
    for (const member of input.staff) {
      for (const hours of hoursForDate(date, member.workingHours, member.datedWorkingHours)) {
        if (hours.weekday !== weekday) continue;
        const { startMs, endMs } = resolveWorkingRange(date, timeZone, hours);
        if (startMs < to.getTime() && endMs > from.getTime()) {
          windows.push({
            staffId: member.staffId,
            startsAt: new Date(startMs),
            endsAt: new Date(endMs),
          });
        }
      }
    }
  }
  return windows.sort(
    (a, b) =>
      a.startsAt.getTime() - b.startsAt.getTime() ||
      a.staffId.localeCompare(b.staffId) ||
      a.endsAt.getTime() - b.endsAt.getTime(),
  );
}
