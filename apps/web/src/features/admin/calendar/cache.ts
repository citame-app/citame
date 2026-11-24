import type { Appointment, CalendarAppointment, CalendarResponse } from "@sob/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { invalidateCommerce } from "../commerce/invalidate";

export function invalidateCalendarData(client: QueryClient) {
  return invalidateCommerce(client);
}

/** Immutable edits of a cached calendar response, used by optimistic updates and rollbacks. */
export function patchAppointment(
  calendar: CalendarResponse,
  id: string,
  patch: Partial<CalendarAppointment>,
  matches: (current: CalendarAppointment) => boolean = () => true,
): CalendarResponse {
  const index = calendar.appointments.findIndex((a) => a.id === id);
  const current = calendar.appointments[index];
  if (!current || !matches(current)) return calendar;
  return {
    ...calendar,
    appointments: calendar.appointments.with(index, { ...current, ...patch }),
  };
}

/** Applies an `Appointment` returned by the API, keeping the joined client and service names. */
export function mergeAppointment(
  calendar: CalendarResponse,
  appointment: Appointment,
): CalendarResponse {
  return patchAppointment(
    calendar,
    appointment.id,
    appointment,
    (current) => current.version <= appointment.version,
  );
}

export function removeAppointment(calendar: CalendarResponse, id: string): CalendarResponse {
  return { ...calendar, appointments: calendar.appointments.filter((a) => a.id !== id) };
}
