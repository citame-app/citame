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
): CalendarResponse {
  if (!calendar.appointments.some((a) => a.id === id)) return calendar;
  return {
    ...calendar,
    appointments: calendar.appointments.map((a) => (a.id === id ? { ...a, ...patch } : a)),
  };
}

/** Applies an `Appointment` returned by the API, keeping the joined client and service names. */
export function mergeAppointment(
  calendar: CalendarResponse,
  appointment: Appointment,
): CalendarResponse {
  return patchAppointment(calendar, appointment.id, appointment);
}

export function removeAppointment(calendar: CalendarResponse, id: string): CalendarResponse {
  return { ...calendar, appointments: calendar.appointments.filter((a) => a.id !== id) };
}
