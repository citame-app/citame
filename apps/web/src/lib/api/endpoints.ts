import {
  type AppointmentListQuery,
  adminClientSchema,
  adminServiceSchema,
  adminStaffSchema,
  appointmentSchema,
  availabilityResponseSchema,
  type CalendarQuery,
  type ClientListQuery,
  type CreateAppointmentRequest,
  type CreateServiceRequest,
  type CreateStaffAccountRequest,
  type CreateTimeOffRequest,
  calendarResponseSchema,
  clientDetailResponseSchema,
  listAdminServicesResponseSchema,
  listAdminStaffResponseSchema,
  listAppointmentsResponseSchema,
  listClientsResponseSchema,
  listServicesResponseSchema,
  listStaffResponseSchema,
  listTimeOffResponseSchema,
  meResponseSchema,
  reportSummarySchema,
  type SetServiceStaffRequest,
  type SetWorkingHoursRequest,
  salonResponseSchema,
  staffAccountResponseSchema,
  timeOffResponseSchema,
  type UpdateAppointmentRequest,
  type UpdateClientRequest,
  type UpdateProfileRequest,
  type UpdateSalonSettingsRequest,
  type UpdateServiceRequest,
  type UpdateStaffRequest,
  type UpdateTimeOffRequest,
  workingHoursResponseSchema,
} from "@sob/contracts";
import { z } from "zod";
import type { ApiClient } from "./client";

/** Better Auth answers with extra fields we do not depend on. */
const authAck = z.looseObject({});
const deletedAck = z.object({ id: z.string(), deleted: z.literal(true) });

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
    admin: {
      calendar: (query: Omit<CalendarQuery, "staffIds"> & { staffIds?: string[] }) =>
        client.get("/appointments/calendar", calendarResponseSchema, {
          query: { from: query.from, to: query.to, staffIds: query.staffIds?.join(",") },
        }),
      clients: {
        list: (query: Partial<ClientListQuery>) =>
          client.get("/admin/clients", listClientsResponseSchema, { query: { ...query } }),
        get: (id: string) => client.get(`/admin/clients/${id}`, clientDetailResponseSchema),
        update: (id: string, request: UpdateClientRequest) =>
          client.patch(`/admin/clients/${id}`, request, adminClientSchema),
        remove: (id: string) => client.delete(`/admin/clients/${id}`, deletedAck),
      },
      services: {
        list: () => client.get("/admin/services", listAdminServicesResponseSchema),
        create: (request: CreateServiceRequest) =>
          client.post("/admin/services", request, adminServiceSchema),
        update: (id: string, request: UpdateServiceRequest) =>
          client.patch(`/admin/services/${id}`, request, adminServiceSchema),
        deactivate: (id: string) => client.delete(`/admin/services/${id}`, adminServiceSchema),
        setStaff: (id: string, request: SetServiceStaffRequest) =>
          client.put(`/admin/services/${id}/staff`, request, adminServiceSchema),
      },
      staff: {
        list: () => client.get("/admin/staff", listAdminStaffResponseSchema),
        create: (request: CreateStaffAccountRequest) =>
          client.post("/admin/staff-accounts", request, staffAccountResponseSchema),
        update: (id: string, request: UpdateStaffRequest) =>
          client.patch(`/admin/staff/${id}`, request, adminStaffSchema),
        workingHours: (id: string) =>
          client.get(`/admin/staff/${id}/working-hours`, workingHoursResponseSchema),
        setWorkingHours: (id: string, request: SetWorkingHoursRequest) =>
          client.put(`/admin/staff/${id}/working-hours`, request, workingHoursResponseSchema),
        timeOff: (id: string, query: { from?: string; to?: string } = {}) =>
          client.get(`/admin/staff/${id}/time-off`, listTimeOffResponseSchema, { query }),
        createTimeOff: (id: string, request: CreateTimeOffRequest) =>
          client.post(`/admin/staff/${id}/time-off`, request, timeOffResponseSchema),
        updateTimeOff: (id: string, entryId: string, request: UpdateTimeOffRequest) =>
          client.patch(`/admin/staff/${id}/time-off/${entryId}`, request, timeOffResponseSchema),
        deleteTimeOff: (id: string, entryId: string) =>
          client.delete(`/admin/staff/${id}/time-off/${entryId}`, timeOffResponseSchema),
      },
      reports: (query: { from: string; to: string; staffId?: string }) =>
        client.get("/admin/reports/summary", reportSummarySchema, { query }),
      settings: {
        get: () => client.get("/admin/settings", salonResponseSchema),
        update: (request: UpdateSalonSettingsRequest) =>
          client.patch("/admin/settings", request, salonResponseSchema),
      },
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
