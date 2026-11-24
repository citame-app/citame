import { z } from "zod";
import { sourceCalendarDate } from "./calendar-intervals";

export function booksyLocalDayBounds(date: string, timezone: string) {
  const day = Temporal.PlainDate.from(z.iso.date().parse(date));
  return {
    start: day.toZonedDateTime(timezone).epochMilliseconds,
    end: day.add({ days: 1 }).toZonedDateTime(timezone).epochMilliseconds,
  };
}

export function importedAppointmentCalendarLink(
  appointmentId: string,
  startsAt: string,
  timezone: string,
) {
  const calendarDate = sourceCalendarDate(startsAt, timezone);
  const search = new URLSearchParams({
    date: calendarDate,
    view: "day",
    appointment: appointmentId,
  });
  return { calendarDate, calendarPath: `/admin/calendar?${search}` };
}
