import { stableJson } from "./plan";

export type CalendarSeen<T> = {
  at: string;
  ref: string;
  start: string;
  end: string;
  row: T;
};

function latestByReference<T>(observations: CalendarSeen<T>[]) {
  const latest = new Map<string, CalendarSeen<T>>();
  const newestFirst = [...observations].sort((a, b) => Temporal.Instant.compare(b.at, a.at));
  for (const observation of newestFirst) {
    const { at, ref, row } = observation;
    const previous = latest.get(ref);
    if (!previous) {
      latest.set(ref, observation);
      continue;
    }
    const order = Temporal.Instant.compare(at, previous.at);
    if (order === 0 && stableJson(row) !== stableJson(previous.row))
      throw new Error("Simultaneous calendar observations disagree about an interval");
  }
  return latest;
}

/** Do not restore the old time of a moved line when its new date is absent in a refresh. */
export function projectCalendarIntervals<T>(
  selected: CalendarSeen<T>[],
  history: CalendarSeen<T>[],
  partialSightings: CalendarSeen<T>[] = [],
  lastFullCaptureByDay: ReadonlyMap<string, string> = new Map(),
) {
  const inCoverage = partialSightings.filter((row) =>
    lastFullCaptureByDay.has(row.start.slice(0, 10)),
  );
  const afterFullCapture = inCoverage.filter((row) => {
    const full = lastFullCaptureByDay.get(row.start.slice(0, 10));
    return full !== undefined && Temporal.Instant.compare(row.at, full) > 0;
  });
  const projected = latestByReference([...selected, ...afterFullCapture]);
  const latestSeen = latestByReference([...history, ...inCoverage]);
  for (const [ref, selected] of projected) {
    const latest = latestSeen.get(ref);
    if (
      latest &&
      Temporal.Instant.compare(latest.at, selected.at) > 0 &&
      (latest.start !== selected.start || latest.end !== selected.end)
    )
      projected.delete(ref);
  }
  return projected;
}
