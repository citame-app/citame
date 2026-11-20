import type { CalendarAppointment, TimeOff, WorkingWindow } from "@sob/contracts";
import { addDaysLocal, localDateOf } from "~/lib/format";
import { localDayBounds, minutesIntoLocalDay } from "~/lib/zoned";

export interface CalendarEntry {
  id: string;
  appointment: CalendarAppointment;
  startsAt: string;
  endsAt: string;
  services: string[];
  color?: string;
  servicePositions: number[];
  /** Offset from the reservation start; dragging any service moves the whole reservation. */
  offsetMinutes: number;
}

/** Split a frozen multi-service plan only when it accounts for the complete reservation. */
export function appointmentEntries(appointment: CalendarAppointment): CalendarEntry[] {
  const total = (Date.parse(appointment.endsAt) - Date.parse(appointment.startsAt)) / 60000;
  const plan = appointment.services.reduce(
    (sum, s) => sum + s.durationMinutes + s.bufferMinutes,
    0,
  );
  if (appointment.services.length < 2 || total !== plan)
    return [
      {
        id: appointment.id,
        appointment,
        startsAt: appointment.startsAt,
        endsAt: appointment.endsAt,
        services: appointment.serviceNames,
        color: appointment.services[0]?.serviceId
          ? appointment.serviceColors?.[appointment.services[0].serviceId]
          : undefined,
        servicePositions: appointment.services.map((_, i) => i),
        offsetMinutes: 0,
      },
    ];
  let offset = 0;
  return appointment.services.flatMap((service, index) => {
    const duration = service.durationMinutes + service.bufferMinutes;
    const start = offset;
    offset += duration;
    return duration > 0
      ? [
          {
            id: `${appointment.id}:${index}`,
            appointment,
            startsAt: new Date(Date.parse(appointment.startsAt) + start * 60000).toISOString(),
            endsAt: new Date(Date.parse(appointment.startsAt) + offset * 60000).toISOString(),
            services: [service.name],
            color: service.serviceId ? appointment.serviceColors?.[service.serviceId] : undefined,
            servicePositions: [index],
            offsetMinutes: start,
          },
        ]
      : [];
  });
}

/** Index once per response rather than re-filtering every appointment on every pointer event. */
export function indexCalendar(appointments: CalendarAppointment[], timeZone: string) {
  const byDay = new Map<string, CalendarAppointment[]>();
  const byColumn = new Map<string, CalendarEntry[]>();
  for (const appointment of appointments) {
    const first = localDateOf(appointment.startsAt, timeZone);
    const last = localDateOf(new Date(Date.parse(appointment.endsAt) - 1).toISOString(), timeZone);
    for (let date = first; date <= last; date = addDaysLocal(date, 1)) {
      const rows = byDay.get(date) ?? [];
      rows.push(appointment);
      byDay.set(date, rows);
    }
    for (const entry of appointmentEntries(appointment)) {
      const start = localDateOf(entry.startsAt, timeZone);
      const end = localDateOf(new Date(Date.parse(entry.endsAt) - 1).toISOString(), timeZone);
      for (let date = start; date <= end; date = addDaysLocal(date, 1)) {
        const key = `${appointment.staffId}:${date}`;
        const rows = byColumn.get(key) ?? [];
        rows.push(entry);
        byColumn.set(key, rows);
      }
    }
  }
  for (const rows of byDay.values()) rows.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  return { byDay, byColumn };
}

/** Wall-clock coordinates, including overnight blocks and the local DST transition day. */
export function localMinuteRange(
  item: { startsAt: string; endsAt: string },
  date: string,
  timeZone: string,
) {
  const bounds = localDayBounds(date, timeZone);
  if (
    Date.parse(item.endsAt) <= Date.parse(bounds.from) ||
    Date.parse(item.startsAt) >= Date.parse(bounds.to)
  )
    return null;
  const start =
    Date.parse(item.startsAt) <= Date.parse(bounds.from)
      ? 0
      : minutesIntoLocalDay(item.startsAt, timeZone);
  const end =
    Date.parse(item.endsAt) >= Date.parse(bounds.to)
      ? 1440
      : minutesIntoLocalDay(item.endsAt, timeZone);
  return { start, end: Math.max(start + 5, end) };
}

export function staffByDay<T extends TimeOff | WorkingWindow>(rows: T[]) {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const group = groups.get(row.staffId) ?? [];
    group.push(row);
    groups.set(row.staffId, group);
  }
  return groups;
}

/** Stable service colour, independent of booking status and staff ordering. */
export function serviceHue(name: string): number {
  let hash = 0;
  for (const char of name.normalize("NFKC").toLowerCase())
    hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return [18, 42, 92, 166, 208, 348][Math.abs(hash) % 6] ?? 12;
}

/** Distinct initials also for numbered or single-letter team labels. */
export function personInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const last = words.at(-1) ?? "";
  return last.length === 1
    ? last.toLocaleUpperCase()
    : `${words[0]?.[0] ?? ""}${words.length > 1 ? last[0] : (words[0]?.[1] ?? "")}`.toLocaleUpperCase();
}
