export interface DatedWorkingHours {
  date: string;
  ranges: { start: string; end: string }[];
}

/** An explicit empty date is closed; a missing date inherits the weekly schedule. */
export function hoursForDate<T extends { weekday: number; start: string; end: string }>(
  date: Temporal.PlainDate,
  weekly: T[],
  dated: DatedWorkingHours[] = [],
): { weekday: number; start: string; end: string }[] {
  const override = dated.find((day) => day.date === date.toString());
  return override
    ? override.ranges.map((range) => ({ ...range, weekday: date.dayOfWeek % 7 }))
    : weekly;
}
