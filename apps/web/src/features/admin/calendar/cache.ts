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

function keepsLatestRevision(current: CalendarAppointment, saved: Appointment): boolean {
  return current.version <= saved.version;
}

/** Merges a confirmed write without losing the joined calendar fields or a newer server version. */
export function mergeCalendarAppointment(
  current: CalendarAppointment,
  saved: Appointment,
): CalendarAppointment {
  return keepsLatestRevision(current, saved) ? { ...current, ...saved } : current;
}

export function mergeAppointment(
  calendar: CalendarResponse,
  appointment: Appointment,
): CalendarResponse {
  return patchAppointment(calendar, appointment.id, appointment, (current) =>
    keepsLatestRevision(current, appointment),
  );
}

export function removeAppointment(calendar: CalendarResponse, id: string): CalendarResponse {
  return { ...calendar, appointments: calendar.appointments.filter((a) => a.id !== id) };
}
