/**
 * Locale- and timezone-aware formatting. Every display of money, durations and times goes
 * through here so the salon timezone and currency are applied in one place.
 */

export function formatMoney(cents: number, currency: string, locale: string): string {
  const amount = cents / 100;
  const whole = Number.isInteger(amount);
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(amount);
}

function unit(locale: string, unitName: "hour" | "minute", value: number): string {
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: unitName,
    unitDisplay: "narrow",
  }).format(value);
}

export function formatDuration(totalMinutes: number, locale: string): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(unit(locale, "hour", hours));
  if (minutes > 0 || hours === 0) parts.push(unit(locale, "minute", minutes));
  return parts.join(" ");
}

export function formatTime(instant: string, timeZone: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone }).format(
    new Date(instant),
  );
}

/** Calendar date (`YYYY-MM-DD`) of an instant as seen in `timeZone`. */
export function localDateOf(instant: string, timeZone: string): string {
  // The "en-CA" locale formats as YYYY-MM-DD, which is what we need as a stable key.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instant));
}

/** Local dates are formatted at noon UTC so no timezone can shift the calendar day. */
function localDateAsDate(localDate: string): Date {
  return new Date(`${localDate}T12:00:00Z`);
}

export function formatDateLong(localDate: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(localDateAsDate(localDate));
}

export function formatDateWithYear(localDate: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(localDateAsDate(localDate));
}

export function weekdayShort(localDate: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" })
    .format(localDateAsDate(localDate))
    .replace(".", "");
}

export function dayOfMonth(localDate: string): number {
  return Number(localDate.slice(8, 10));
}

export function monthShort(localDate: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" })
    .format(localDateAsDate(localDate))
    .replace(".", "");
}

/** Adds whole days to a local date. Pure calendar arithmetic, immune to DST. */
export function addDaysLocal(localDate: string, days: number): string {
  const date = localDateAsDate(localDate);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Hour (0-23) of an instant in `timeZone`. */
export function hourOf(instant: string, timeZone: string): number {
  const hour = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hourCycle: "h23",
    timeZone,
  }).format(new Date(instant));
  return Number(hour);
}
