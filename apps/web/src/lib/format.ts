/**
 * Locale- and timezone-aware formatting. Every display of money, durations and times goes
 * through here so the salon timezone and currency are applied in one place.
 */

const dateFormatters = new Map<string, Intl.DateTimeFormat>();

/** Share formatters, never formatted user data. Bound the process-wide cache for SSR. */
export function dateFormatter(locale: string, options: Intl.DateTimeFormatOptions) {
  const key = JSON.stringify([locale, options]);
  let formatter = dateFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options);
    if (dateFormatters.size >= 80) {
      const oldest = dateFormatters.keys().next().value;
      if (oldest !== undefined) dateFormatters.delete(oldest);
    }
    dateFormatters.set(key, formatter);
  }
  return formatter;
}

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
  // Browsers separate the day period with U+202F, Bun with a plain space: normalize so server
  // and client render identical text (a mismatch breaks hydration).
  return dateFormatter(locale, {
    hour: locale.startsWith("es") ? "2-digit" : "numeric",
    minute: "2-digit",
    // Explicit: the default clock for a locale differs between ICU versions (es-AR is 24h in one
    // and "a. m./p. m." in another), which would make server and browser render different text.
    hourCycle: locale.startsWith("es") ? "h23" : "h12",
    timeZone,
  })
    .format(new Date(instant))
    .replaceAll("\u202f", " ");
}

/** Calendar date (`YYYY-MM-DD`) of an instant as seen in `timeZone`. */
export function localDateOf(instant: string, timeZone: string): string {
  // The "en-CA" locale formats as YYYY-MM-DD, which is what we need as a stable key.
  return dateFormatter("en-CA", {
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
  return dateFormatter(locale, {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(localDateAsDate(localDate));
}

export function formatDateWithYear(localDate: string, locale: string): string {
  return dateFormatter(locale, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(localDateAsDate(localDate));
}

export function weekdayShort(localDate: string, locale: string): string {
  return dateFormatter(locale, { weekday: "short", timeZone: "UTC" })
    .format(localDateAsDate(localDate))
    .replace(".", "");
}

export function dayOfMonth(localDate: string): number {
  return Number(localDate.slice(8, 10));
}

export function monthShort(localDate: string, locale: string): string {
  return dateFormatter(locale, { month: "short", timeZone: "UTC" })
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
  const hour = dateFormatter("en-US", {
    hour: "numeric",
    hourCycle: "h23",
    timeZone,
  }).format(new Date(instant));
  return Number(hour);
}
