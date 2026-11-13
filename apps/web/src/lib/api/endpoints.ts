import {
  type AppointmentListQuery,
  appointmentSchema,
  availabilityResponseSchema,
  type CreateAppointmentRequest,
  listAppointmentsResponseSchema,
  listServicesResponseSchema,
  listStaffResponseSchema,
  meResponseSchema,
  salonResponseSchema,
  type UpdateAppointmentRequest,
  type UpdateProfileRequest,
} from "@sob/contracts";
import { z } from "zod";
import type { ApiClient } from "./client";

/** Better Auth answers with extra fields we do not depend on. */
const authAck = z.looseObject({});

export interface AvailabilityParams {
  serviceIds: string[];
  staffId?: string;
  date: string;
}

type CreateBooking = Omit<CreateAppointmentRequest, "clientId" | "client">;

/** Every call the web app makes, typed from the shared contracts and validated at runtime. */
export function createEndpoints(client: ApiClient) {
  return {
    salon: () => client.get("/salon", salonResponseSchema),
    services: () => client.get("/services", listServicesResponseSchema),
    staff: () => client.get("/staff", listStaffResponseSchema),
    availability: ({ serviceIds, staffId, date }: AvailabilityParams, signal?: AbortSignal) =>
      client.get("/availability", availabilityResponseSchema, {
        query: { serviceIds: serviceIds.join(","), staffId, date },
        signal,
      }),
    me: () => client.get("/me", meResponseSchema),
    updateProfile: (request: UpdateProfileRequest) =>
      client.patch("/me", request, meResponseSchema),
    appointments: {
      list: (query: Pick<AppointmentListQuery, "from" | "to" | "status" | "page" | "pageSize">) =>
        client.get("/appointments", listAppointmentsResponseSchema, {
          query: {
            from: query.from,
            to: query.to,
            status: query.status?.join(","),
            page: query.page,
            pageSize: query.pageSize,
          },
        }),
      create: (request: CreateBooking) => client.post("/appointments", request, appointmentSchema),
      update: (id: string, request: UpdateAppointmentRequest) =>
        client.patch(`/appointments/${id}`, request, appointmentSchema),
      cancel: (id: string, version: number) =>
        client.patch(`/appointments/${id}`, { version, status: "cancelled" }, appointmentSchema),
      reschedule: (id: string, version: number, startsAt: string, staffId?: string) =>
        client.patch(`/appointments/${id}`, { version, startsAt, staffId }, appointmentSchema),
    },
    auth: {
      signIn: (credentials: { email: string; password: string }) =>
        client.post("/api/auth/sign-in/email", credentials, authAck),
      signUp: (details: { email: string; password: string; name: string }) =>
        client.post("/api/auth/sign-up/email", details, authAck),
      signOut: () => client.post("/api/auth/sign-out", {}, authAck),
    },
  };
}

export type Endpoints = ReturnType<typeof createEndpoints>;
