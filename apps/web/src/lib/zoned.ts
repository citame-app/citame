import { addDaysLocal, dateFormatter } from "./format";

function offsetMs(utcMs: number, timeZone: string): number {
  const parts = dateFormatter("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** The UTC instant at which `timeZone` shows `localDate` at `HH:MM` (DST-correct). */
export function zonedInstant(localDate: string, time: string, timeZone: string): string {
  const [year, month, day] = localDate.split("-").map(Number) as [number, number, number];
  const [hour, minute] = time.split(":").map(Number) as [number, number];
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  let result = naive - offsetMs(naive, timeZone);
  // The offset at the guess may differ from the offset at the answer around a DST change.
  result = naive - offsetMs(result, timeZone);
  return new Date(result).toISOString();
}

/** `[from, to)` of a local calendar day as instants. */
export function localDayBounds(localDate: string, timeZone: string) {
  return {
    from: zonedInstant(localDate, "00:00", timeZone),
    to: zonedInstant(addDaysLocal(localDate, 1), "00:00", timeZone),
  };
}

export function minutesIntoLocalDay(instant: string, timeZone: string): number {
  const parts = dateFormatter("en-US", {
    timeZone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return get("hour") * 60 + get("minute");
}

/** Monday of the week containing `localDate`. */
export function startOfWeek(localDate: string): string {
  const weekday = new Date(`${localDate}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDaysLocal(localDate, -((weekday + 6) % 7));
}

export function weekDates(localDate: string): string[] {
  const monday = startOfWeek(localDate);
  return Array.from({ length: 7 }, (_, i) => addDaysLocal(monday, i));
}

/** 0 = Sunday ... 6 = Saturday, matching the API's `weekday`. */
export function weekdayOf(localDate: string): number {
  return new Date(`${localDate}T12:00:00Z`).getUTCDay();
}
