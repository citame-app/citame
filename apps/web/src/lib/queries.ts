import { queryOptions } from "@tanstack/react-query";
import type { AvailabilityParams } from "./api/endpoints";
import { api } from "./api/instance";

export const salonQuery = queryOptions({
  queryKey: ["salon"],
  queryFn: () => api().salon(),
  staleTime: 10 * 60_000,
});

export const servicesQuery = queryOptions({
  queryKey: ["services"],
  queryFn: async () => (await api().services()).services,
  staleTime: 60_000,
});

export const staffQuery = queryOptions({
  queryKey: ["staff"],
  queryFn: async ({ signal }) => (await api().staff(false, signal)).staff,
  staleTime: 60_000,
});

export const publicCombinationsQuery = queryOptions({
  queryKey: ["combinations", "public"],
  queryFn: () => api().combinations.list(),
  staleTime: 30_000,
});

export const availabilityQuery = (params: AvailabilityParams) =>
  queryOptions({
    queryKey: [
      "availability",
      params.date,
      params.serviceIds.join(","),
      params.staffId ?? "any",
      params.appointmentId ?? "new",
      params.combinationId ?? null,
    ],
    enabled: params.serviceIds.length > 0,
    queryFn: ({ signal }) => api().availability(params, signal),
    staleTime: 30_000,
  });

const DAY_MS = 86_400_000;

/** Every appointment of the signed-in client within a year either side of today. */
export const myAppointmentsQuery = queryOptions({
  queryKey: ["appointments", "mine"],
  queryFn: async () => {
    const now = Date.now();
    const result = await api().appointments.list({
      from: new Date(now - 365 * DAY_MS).toISOString(),
      to: new Date(now + 365 * DAY_MS).toISOString(),
      pageSize: 200,
    });
    return result.appointments;
  },
  staleTime: 15_000,
});
