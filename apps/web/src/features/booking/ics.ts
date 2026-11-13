export interface IcsEvent {
  uid: string;
  startsAt: string;
  endsAt: string;
  summary: string;
  description?: string;
  location?: string;
  /** Injectable for deterministic output. */
  now?: Date;
}

const compact = (instant: string | Date) =>
  new Date(instant).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

const escapeText = (value: string) =>
  value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");

/** RFC 5545 section 3.1: lines are at most 75 octets; continuation lines start with a space. */
function fold(line: string): string[] {
  const encoder = new TextEncoder();
  const lines: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const char of line) {
    const bytes = encoder.encode(char).length;
    const limit = lines.length === 0 ? 75 : 74;
    if (currentBytes + bytes > limit) {
      lines.push(lines.length === 0 ? current : ` ${current}`);
      current = "";
      currentBytes = 0;
    }
    current += char;
    currentBytes += bytes;
  }
  lines.push(lines.length === 0 ? current : ` ${current}`);
  return lines;
}

export function buildIcs(event: IcsEvent): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Sisters of Beauty//Booking//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${event.uid}@sistersofbeauty`,
    `DTSTAMP:${compact(event.now ?? new Date())}`,
    `DTSTART:${compact(event.startsAt)}`,
    `DTEND:${compact(event.endsAt)}`,
    `SUMMARY:${escapeText(event.summary)}`,
  ];
  if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
  if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
  lines.push(
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${escapeText(event.summary)}`,
    "TRIGGER:-PT1H",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  );
  return `${lines.flatMap(fold).join("\r\n")}\r\n`;
}

export function icsFileName(localDate: string): string {
  return `appointment-${localDate}.ics`;
}
