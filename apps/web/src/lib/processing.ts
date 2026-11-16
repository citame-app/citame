export interface ProcessingRange {
  startsAt: string;
  endsAt: string;
  offsetMinutes: number;
  minutes: number;
}
interface TimedVisit {
  startsAt: string;
  endsAt: string;
  workWindows?: { offsetMinutes: number; endOffsetMinutes: number }[];
  services: {
    durationMinutes: number;
    bufferMinutes: number;
    processing?: { startsAfterMinutes: number; minutes: number };
  }[];
}
/** Annotations are derived from the visit's frozen work plan, never the current catalog. */
export function processingRanges(visit: TimedVisit): ProcessingRange[] {
  const start = Date.parse(visit.startsAt),
    total = (Date.parse(visit.endsAt) - start) / 60000;
  if (!Number.isFinite(start) || !Number.isFinite(total) || total <= 0) return [];
  const gaps: { offsetMinutes: number; minutes: number }[] = [];
  if (visit.workWindows) {
    const windows = visit.workWindows;
    if (
      !windows.length ||
      windows[0]?.offsetMinutes !== 0 ||
      windows.at(-1)?.endOffsetMinutes !== total
    )
      return [];
    let previous = 0;
    for (const window of windows) {
      if (
        !Number.isFinite(window.offsetMinutes) ||
        !Number.isFinite(window.endOffsetMinutes) ||
        window.offsetMinutes < previous ||
        window.endOffsetMinutes <= window.offsetMinutes ||
        window.endOffsetMinutes > total
      )
        return [];
      if (window.offsetMinutes > previous)
        gaps.push({ offsetMinutes: previous, minutes: window.offsetMinutes - previous });
      previous = window.endOffsetMinutes;
    }
  } else {
    let offset = 0;
    for (const service of visit.services) {
      const processing = service.processing;
      if (
        processing &&
        processing.startsAfterMinutes > 0 &&
        processing.minutes > 0 &&
        processing.startsAfterMinutes + processing.minutes < service.durationMinutes &&
        offset + service.durationMinutes + service.bufferMinutes <= total
      )
        gaps.push({
          offsetMinutes: offset + processing.startsAfterMinutes,
          minutes: processing.minutes,
        });
      offset += service.durationMinutes + service.bufferMinutes;
    }
  }
  return gaps.map((gap) => ({
    ...gap,
    startsAt: new Date(start + gap.offsetMinutes * 60000).toISOString(),
    endsAt: new Date(start + (gap.offsetMinutes + gap.minutes) * 60000).toISOString(),
  }));
}
