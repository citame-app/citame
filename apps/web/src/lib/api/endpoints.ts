import {
  type AppointmentListQuery,
  adminClientSchema,
  adminServiceSchema,
  adminStaffSchema,
  appointmentSchema,
  availabilityResponseSchema,
  type CalendarQuery,
  type ClientControlsInput,
  type ClientImportInput,
  type ClientListQuery,
  type CreateAppointmentRequest,
  type CreateServiceRequest,
  type CreateStaffAccountRequest,
  type CreateTimeOffRequest,
  calendarResponseSchema,
  clientControlsSchema,
  clientDetailResponseSchema,
  clientExportSchema,
  clientImportPreviewSchema,
  clientImportResultSchema,
  listAdminServicesResponseSchema,
  listAdminStaffResponseSchema,
  listAppointmentsResponseSchema,
  listClientsResponseSchema,
  listServicesResponseSchema,
  listStaffResponseSchema,
  listTimeOffResponseSchema,
  meResponseSchema,
  notificationPreferencesSchema,
  optOutPreviewSchema,
  ownerSalonSettingsSchema,
  reportSummarySchema,
  type ServiceConfiguration,
  type SetServiceStaffRequest,
  type SetWorkingHoursRequest,
  type StaffAccessPreset,
  salonResponseSchema,
  staffAccessSchema,
  staffAccountResponseSchema,
  timeOffResponseSchema,
  type UpdateAppointmentRequest,
  type UpdateClientRequest,
  type UpdateNotificationPreferencesRequest,
  type UpdateProfileRequest,
  type UpdateSalonSettingsRequest,
  type UpdateServiceRequest,
  type UpdateStaffRequest,
  type UpdateTimeOffRequest,
  workingHoursResponseSchema,
} from "@sob/contracts";
import { z } from "zod";
import { accountingEndpoints } from "./accounting-endpoints";
import { bookingPolicyEndpoints } from "./booking-policy-endpoints";
import type { ApiClient } from "./client";
import { commerceEndpoints } from "./commerce-endpoints";
import { giftCardEndpoints } from "./gift-card-endpoints";
import { inventoryEndpoints } from "./inventory-endpoints";
import { passEndpoints } from "./pass-endpoints";
import { resourceEndpoints } from "./resource-endpoints";
import { rewardEndpoints } from "./reward-endpoints";
import { seriesEndpoints } from "./series-endpoints";
import { waitlistEndpoints } from "./waitlist-endpoints";

/** Better Auth answers with extra fields we do not depend on. */
const authAck = z.looseObject({});
/**
 * Sign-in and sign-up answer `{ redirect: true, url }` when they were sent the signed query of
 * an authorization request: the server has already resumed the flow and says where to go next.
 */
const authContinuation = z.looseObject({
  url: z.string().optional(),
  /** Null when the address still has to be confirmed: the account exists but there is no session. */
  token: z.string().nullable().optional(),
});
/** Public fields of an OAuth client, as the consent screen needs them. */
const oauthClientSchema = z.looseObject({
  client_id: z.string(),
  client_name: z.string().optional(),
  client_uri: z.string().optional(),
  logo_uri: z.string().optional(),
  tos_uri: z.string().optional(),
  policy_uri: z.string().optional(),
});
const consentResultSchema = z.object({ url: z.string() });
export type OAuthClientInfo = z.infer<typeof oauthClientSchema>;
const deletedAck = z.object({ id: z.string(), deleted: z.literal(true) });

export interface AvailabilityParams {
  appointmentId?: string;
  serviceIds: string[];
  staffId?: string;
  date: string;
}

type CreateBooking = Omit<CreateAppointmentRequest, "clientId" | "client">;

/** Every call the web app makes, typed from the shared contracts and validated at runtime. */
export function createEndpoints(client: ApiClient) {
  return {
    commerce: commerceEndpoints(client),
    bookingPolicy: bookingPolicyEndpoints(client),
    inventory: inventoryEndpoints(client),
    accounting: accountingEndpoints(client),
    giftCards: giftCardEndpoints(client),
    passes: passEndpoints(client),
    rewards: rewardEndpoints(client),
    resources: resourceEndpoints(client),
    appointmentSeries: seriesEndpoints(client),
    waitlist: waitlistEndpoints(client),
    salon: () => client.get("/salon", salonResponseSchema),
    services: () => client.get("/services", listServicesResponseSchema),
    staff: () => client.get("/staff", listStaffResponseSchema),
    availability: (
      { serviceIds, staffId, date, appointmentId }: AvailabilityParams,
      signal?: AbortSignal,
    ) =>
      client.get(
        appointmentId ? `/appointments/${appointmentId}/availability` : "/availability",
        availabilityResponseSchema,
        {
          query: { serviceIds: serviceIds.join(","), staffId, date },
          signal,
        },
      ),
    me: () => client.get("/me", meResponseSchema),
    updateProfile: (request: UpdateProfileRequest) =>
      client.patch("/me", request, meResponseSchema),
    notificationPreferences: {
      get: () => client.get("/me/notification-preferences", notificationPreferencesSchema),
      update: (request: UpdateNotificationPreferencesRequest) =>
        client.patch("/me/notification-preferences", request, notificationPreferencesSchema),
    },
    /** Public, login-free: the signed link in a reminder email. GET only describes. */
    optOut: {
      preview: (token: string) =>
        client.get("/notifications/opt-out", optOutPreviewSchema, { query: { token } }),
      confirm: (token: string) =>
        client.post("/notifications/opt-out", { token }, optOutPreviewSchema),
    },
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
        previewImport: (csv: string) =>
          client.post("/admin/clients/import/preview", { csv }, clientImportPreviewSchema),
        import: (input: ClientImportInput) =>
          client.post("/admin/clients/import", input, clientImportResultSchema),
        export: (search?: string) =>
          client.get("/admin/clients/export", clientExportSchema, { query: { search } }),
        controls: (id: string) => client.get(`/admin/clients/${id}/controls`, clientControlsSchema),
        updateControls: (id: string, input: ClientControlsInput) =>
          client.patch(`/admin/clients/${id}/controls`, input, clientControlsSchema),
        list: (query: Partial<ClientListQuery>) =>
          client.get("/admin/clients", listClientsResponseSchema, { query: { ...query } }),
        get: (id: string) => client.get(`/admin/clients/${id}`, clientDetailResponseSchema),
        update: (id: string, request: UpdateClientRequest) =>
          client.patch(`/admin/clients/${id}`, request, adminClientSchema),
        remove: (id: string) => client.delete(`/admin/clients/${id}`, deletedAck),
      },
      services: {
        configure: (id: string, request: ServiceConfiguration) =>
          client.put(`/admin/services/${id}/configuration`, request, adminServiceSchema),
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
        access: (id: string) => client.get(`/admin/staff/${id}/access`, staffAccessSchema),
        setAccess: (id: string, body: { preset: StaffAccessPreset; version: number }) =>
          client.put(`/admin/staff/${id}/access`, body, staffAccessSchema),
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
        get: () => client.get("/admin/settings", ownerSalonSettingsSchema),
        update: (request: UpdateSalonSettingsRequest) =>
          client.patch("/admin/settings", request, ownerSalonSettingsSchema),
      },
    },
    auth: {
      signIn: (credentials: { email: string; password: string }, oauthQuery?: string) =>
        client.post(
          "/api/auth/sign-in/email",
          oauthQuery ? { ...credentials, oauth_query: oauthQuery } : credentials,
          authContinuation,
        ),
      /**
       * Creates the account. With email verification on, Better Auth answers without a session
       * token: `verificationRequired` tells the caller to show "check your inbox" instead of
       * pretending the visitor is signed in. `callbackURL` is where the emailed link lands.
       */
      signUp: async (
        details: { email: string; password: string; name: string },
        oauthQuery?: string,
        callbackURL?: string,
      ) => {
        const body = {
          ...details,
          ...(oauthQuery ? { oauth_query: oauthQuery } : {}),
          ...(callbackURL ? { callbackURL } : {}),
        };
        const result = await client.post("/api/auth/sign-up/email", body, authContinuation);
        return { ...result, verificationRequired: result.token === null };
      },
      requestPasswordReset: (email: string) =>
        client.post(
          "/api/auth/request-password-reset",
          { email, redirectTo: "/reset-password" },
          authAck,
        ),
      resetPassword: (token: string, newPassword: string) =>
        client.post("/api/auth/reset-password", { token, newPassword }, authAck),
      resendVerification: (email: string, callbackURL: string) =>
        client.post("/api/auth/send-verification-email", { email, callbackURL }, authAck),
      signOut: () => client.post("/api/auth/sign-out", {}, authAck),
    },
    oauth: {
      client: (clientId: string) =>
        client.get("/api/auth/oauth2/public-client", oauthClientSchema, {
          query: { client_id: clientId },
        }),
      /** Approves (with the scopes the user left on) or denies an authorization request. */
      consent: (decision: { accept: boolean; scopes: string[]; query: string }) =>
        client.post(
          "/api/auth/oauth2/consent",
          decision.accept
            ? { accept: true, scope: decision.scopes.join(" "), oauth_query: decision.query }
            : { accept: false, oauth_query: decision.query },
          consentResultSchema,
        ),
    },
  };
}

export type Endpoints = ReturnType<typeof createEndpoints>;
