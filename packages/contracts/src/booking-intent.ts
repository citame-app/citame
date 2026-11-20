import type { CreateAppointmentRequest } from "./appointments";

type BookingIntent = Pick<
  CreateAppointmentRequest,
  "staffId" | "serviceIds" | "startsAt" | "clientId" | "client" | "notes" | "professionalPreference"
>;

/** Stable intent identity. Refreshed quotes/consent never create a second visit on retry. */
export function bookingIntentKey(input: BookingIntent): string {
  return JSON.stringify([
    input.staffId,
    [...new Set(input.serviceIds)],
    new Date(input.startsAt).toISOString(),
    input.clientId ?? null,
    input.client
      ? [input.client.name, input.client.email ?? null, input.client.phone ?? null]
      : null,
    input.notes ?? null,
    ...(input.professionalPreference ? [input.professionalPreference] : []),
  ]);
}
