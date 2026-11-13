/**
 * Pure availability computation. No I/O, no clock access: everything it needs is passed
 * in, which keeps it trivially testable and reusable from REST and MCP.
 *
 * Local-time handling uses the built-in `Temporal` API (Bun 1.4+). Working hours are
 * wall-clock times in the salon timezone; they are resolved to absolute instants for the
 * requested date, so DST transitions are handled by the timezone database rather than by
 * hand-rolled offset math.
 */

const MS_PER_MINUTE = 60_000;

export interface TimeRange {
  start: Date;
  end: Date;
}

/** Recurring weekly range in salon-local wall-clock time. `weekday`: 0 = Sunday ... 6 = Saturday. */
export interface WorkingRange {
  weekday: number;
  /** `HH:MM` or `HH:MM:SS`, as returned by Postgres `time`. */
  start: string;
  end: string;
}

export interface StaffAvailabilityInput {
  staffId: string;
  workingHours: WorkingRange[];
  timeOff: TimeRange[];
  /** Blocking appointments (cancelled ones excluded by the caller); `end` includes buffers. */
  appointments: TimeRange[];
}

export interface AvailabilityInput {
  /** Salon-local calendar date, `YYYY-MM-DD`. */
  date: string;
  /** IANA timezone of the salon. */
  timeZone: string;
  granularityMinutes: number;
  minNoticeMinutes: number;
  maxDaysAhead: number;
  now: Date;
  /** Total minutes to block, see `totalBlockMinutes`. */
  blockMinutes: number;
  staff: StaffAvailabilityInput[];
}

export interface ComputedSlot {
  staffId: string;
  startsAt: Date;
  endsAt: Date;
}

/**
 * Block length for a multi-service booking: every service contributes its duration plus
 * its own buffer (cleanup time after that service).
 */
export function totalBlockMinutes(
  services: { durationMinutes: number; bufferMinutes: number }[],
): number {
  return services.reduce((sum, s) => sum + s.durationMinutes + s.bufferMinutes, 0);
}

function overlaps(startMs: number, endMs: number, ranges: TimeRange[]): boolean {
  return ranges.some((r) => startMs < r.end.getTime() && endMs > r.start.getTime());
}

function parseTime(value: string): Temporal.PlainTime {
  const [hour = "0", minute = "0", second = "0"] = value.split(":");
  return new Temporal.PlainTime(Number(hour), Number(minute), Number(second));
}

export function computeAvailability(input: AvailabilityInput): ComputedSlot[] {
  const { timeZone, granularityMinutes, blockMinutes } = input;
  const date = Temporal.PlainDate.from(input.date);

  const today = Temporal.Instant.fromEpochMilliseconds(input.now.getTime())
    .toZonedDateTimeISO(timeZone)
    .toPlainDate();
  const daysAhead = today.until(date, { largestUnit: "days" }).days;
  if (daysAhead < 0 || daysAhead > input.maxDaysAhead) return [];

  const weekday = date.dayOfWeek % 7; // Temporal: 1 = Monday ... 7 = Sunday
  const earliestMs = input.now.getTime() + input.minNoticeMinutes * MS_PER_MINUTE;
  const stepMs = granularityMinutes * MS_PER_MINUTE;
  const blockMs = blockMinutes * MS_PER_MINUTE;

  const slots: ComputedSlot[] = [];
  for (const member of input.staff) {
    for (const hours of member.workingHours) {
      if (hours.weekday !== weekday) continue;
      const rangeStart = date.toZonedDateTime({
        timeZone,
        plainTime: parseTime(hours.start),
      }).epochMilliseconds;
      const rangeEnd = date.toZonedDateTime({
        timeZone,
        plainTime: parseTime(hours.end),
      }).epochMilliseconds;

      for (let start = rangeStart; start + blockMs <= rangeEnd; start += stepMs) {
        const end = start + blockMs;
        if (start < earliestMs) continue;
        if (overlaps(start, end, member.timeOff) || overlaps(start, end, member.appointments)) {
          continue;
        }
        slots.push({
          staffId: member.staffId,
          startsAt: new Date(start),
          endsAt: new Date(end),
        });
      }
    }
  }

  return slots.sort(
    (a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.staffId.localeCompare(b.staffId),
  );
}
