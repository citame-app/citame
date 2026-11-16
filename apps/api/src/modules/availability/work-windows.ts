import { createResourceCapacityCalendar } from "../resources/plan";
export interface WorkWindow {
  offsetMinutes: number;
  endOffsetMinutes: number;
}
export interface ProcessingTime {
  startsAfterMinutes: number;
  minutes: number;
}
/** The full visit still includes processing and cleanup; only hands-on work consumes the professional. */
export function serviceWorkWindows(
  services: {
    durationMinutes: number;
    bufferMinutes: number;
    processing?: ProcessingTime | null;
  }[],
): WorkWindow[] {
  const result: WorkWindow[] = [];
  let offset = 0;
  const append = (start: number, end: number) => {
    if (end <= start) return;
    const previous = result.at(-1);
    if (previous?.endOffsetMinutes === start) previous.endOffsetMinutes = end;
    else result.push({ offsetMinutes: start, endOffsetMinutes: end });
  };
  for (const service of services) {
    const { durationMinutes: duration, bufferMinutes: buffer, processing } = service;
    if (![duration, buffer].every((n) => Number.isSafeInteger(n) && n >= 0))
      throw new RangeError("Invalid service time");
    if (processing) {
      const { startsAfterMinutes: before, minutes: gap } = processing;
      if (![before, gap].every((n) => Number.isSafeInteger(n) && n > 0) || before + gap >= duration)
        throw new RangeError("Processing requires hands-on work before and after it");
      append(offset, offset + before);
      append(offset + before + gap, offset + duration + buffer);
    } else append(offset, offset + duration + buffer);
    offset += duration + buffer;
  }
  return result;
}
/** Reuses the pooled capacity sweep: old unit labels never hide a feasible future interval. */
export function createStaffCapacityCalendar(
  capacity: number,
  occupied: { start: number; end: number }[],
) {
  const calendar = createResourceCapacityCalendar(
    capacity,
    occupied.map((row) => ({ ...row, unitIndex: 0 })),
  );
  return (requests: { start: number; end: number }[]) =>
    calendar?.(requests.map((row, position) => ({ ...row, position, quantity: 1 }))) ?? false;
}
