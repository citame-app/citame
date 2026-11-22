import {
  type AppointmentContextUpdate,
  type AppointmentListQuery,
  adminClientSchema,
  adminServiceSchema,
  adminStaffSchema,
  appointmentContextSchema,
  appointmentSchema,
  availabilityResponseSchema,
  type BooksyContextImport,
  booksyContextReviewSchema,
  type CalendarQuery,
  type ClientControlsInput,
  type ClientImportInput,
  type ClientListQuery,
  type ClientMergeInput,
  type ClientMergePair,
  type ClientPhotoUpdate,
  type ClientPhotoUpload,
  type CreateAppointmentRequest,
  type CreateClientRequest,
  type CreateServiceRequest,
  type CreateStaffAccountRequest,
  type CreateTimeOffRequest,
  calendarResponseSchema,
  changeRoleResponseSchema,
  clientControlsSchema,
  clientDetailResponseSchema,
  clientDuplicatesSchema,
  clientExportSchema,
  clientGroupsSchema,
  clientImportPreviewSchema,
  clientImportResultSchema,
  clientMergePreviewSchema,
  clientMergeSchema,
  clientPhotoSchema,
  clientPhotosSchema,
  desktopDevicesSchema,
  desktopSalonSettingsSchema,
  type EmailDeliveryInput,
  type EmailDeliverySettings,
  emailDeliverySettingsSchema,
  emailDeliveryTestReceiptSchema,
  listAdminServicesResponseSchema,
  listAdminStaffResponseSchema,
  listAppointmentsResponseSchema,
  listClientsResponseSchema,
  listServicesResponseSchema,
  listStaffResponseSchema,
  listTimeOffResponseSchema,
  meResponseSchema,
  notificationPreferencesSchema,
  oauthConnectionsSchema,
  optOutPreviewSchema,
  ownerSalonSettingsSchema,
  publicBusinessProfileSchema,
  type ReportOutcomesQuery,
  type ReviewedBusinessProfileRequest,
  type ReviewedStaffAccessInput,
  type ReviewedStaffRoleInput,
  type ReviewedUnlinkedRoleInput,
  reportClientsSchema,
  reportOutcomesPageSchema,
  reportSummarySchema,
  reviewedStaffAccessSchema,
  type ServiceConfiguration,
  type SetServiceStaffRequest,
  type SetWorkingHoursRequest,
  type StaffPortraitInput,
  type StaffPortraitPublication,
  salonResponseSchema,
  staffAccountResponseSchema,
  staffPortraitResultSchema,
  syncPullResponseSchema,
  timeOffResponseSchema,
  type UpdateAppointmentRequest,
  type UpdateClientRequest,
  type UpdateNotificationPreferencesRequest,
  type UpdateProfileRequest,
  type UpdateSalonSettingsRequest,
  type UpdateServiceRequest,
  type UpdateStaffRequest,
  type UpdateTimeOffRequest,
  unlinkedAccountReviewSchema,
  type WhatsAppReviewedConnect,
  type WhatsAppReviewedDisconnect,
  type WhatsAppReviewedRules,
  whatsappDeliveriesSchema,
  whatsappSettingsSchema,
  whatsappTemplateSchema,
  workingHoursResponseSchema,
} from "@sob/contracts";
import { z } from "zod";
import { accountingEndpoints } from "./accounting-endpoints";
import { bookingPolicyEndpoints } from "./booking-policy-endpoints";
import { calendarInboxEndpoints } from "./calendar-inbox-endpoints";
import type { ApiClient } from "./client";
import { combinationEndpoints } from "./combination-endpoints";
import { commerceEndpoints } from "./commerce-endpoints";
import { dateShiftEndpoints } from "./date-shift-endpoints";
import { giftCardEndpoints } from "./gift-card-endpoints";
import { intakeEndpoints } from "./intake-endpoints";
import { inventoryEndpoints } from "./inventory-endpoints";
import { marketingEndpoints } from "./marketing-endpoints";
import { passEndpoints } from "./pass-endpoints";
import { portfolioEndpoints } from "./portfolio-endpoints";
import { resourceEndpoints } from "./resource-endpoints";
import { reviewEndpoints } from "./review-endpoints";
import { rewardEndpoints } from "./reward-endpoints";
import { schedulingPolicyEndpoints } from "./scheduling-policy-endpoints";
import { seriesEndpoints } from "./series-endpoints";
import { visitEndpoints } from "./visit-endpoints";
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
    dateShifts: dateShiftEndpoints(client),
    reviews: reviewEndpoints(client),
    portfolio: portfolioEndpoints(client),
    intake: intakeEndpoints(client),
    commerce: commerceEndpoints(client),
    bookingPolicy: bookingPolicyEndpoints(client),
    schedulingPolicy: schedulingPolicyEndpoints(client),
    combinations: combinationEndpoints(client),
    inventory: inventoryEndpoints(client),
    marketing: marketingEndpoints(client),
    accounting: accountingEndpoints(client),
    giftCards: giftCardEndpoints(client),
    passes: passEndpoints(client),
    rewards: rewardEndpoints(client),
    resources: resourceEndpoints(client),
    appointmentSeries: seriesEndpoints(client),
    visits: visitEndpoints(client),
    waitlist: waitlistEndpoints(client),
    calendarInbox: calendarInboxEndpoints(client),
    salon: () => client.get("/salon", salonResponseSchema),
    businessProfile: () => client.get("/salon/profile", publicBusinessProfileSchema),
    services: (fresh = false) =>
      client.get("/services", listServicesResponseSchema, {
        cache: fresh ? "no-store" : undefined,
      }),
    staff: (fresh = false, signal?: AbortSignal) =>
      client.get("/staff", listStaffResponseSchema, {
        cache: fresh ? "no-store" : undefined,
        signal,
      }),
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
    me: (signal?: AbortSignal) => client.get("/me", meResponseSchema, { signal }),
    oauthConnections: {
      list: () => client.get("/me/connections", oauthConnectionsSchema),
      revoke: (clientId: string) =>
        client.delete(`/me/connections/${encodeURIComponent(clientId)}`, z.null()),
    },
    desktopDevices: {
      list: (signal?: AbortSignal) =>
        client.get("/me/desktop-devices", desktopDevicesSchema, { signal }),
      revoke: (id: string) =>
        client.delete(`/me/desktop-devices/${encodeURIComponent(id)}`, z.null()),
    },
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
    sync: {
      pull: (since: number, signal?: AbortSignal) =>
        client.get("/sync/pull", syncPullResponseSchema, {
          query: {
            since,
            limit: 200,
            reviewRequests: "1",
            portfolio: "1",
            intakeViews: "1",
            bookingPolicy: "1",
            emailDelivery: "1",
            marketingViews: "1",
            promotionViews: "1",
            loyaltyViews: "1",
            whatsappDesk: "1",
            whatsappSettings: "1",
            resourceCatalogue: "1",
            combinationCatalogue: "1",
          },
          signal,
          cache: "no-store",
        }),
    },
    appointments: {
      catalog: () => client.get("/appointments/catalog", listServicesResponseSchema),
      context: (id: string) => client.get(`/appointments/${id}/context`, appointmentContextSchema),
      updateContext: (id: string, request: AppointmentContextUpdate) =>
        client.patch(`/appointments/${id}/context`, request, appointmentContextSchema),
      previewBooksyContext: (input: BooksyContextImport) =>
        client.post("/appointments/booksy-context/preview", input, booksyContextReviewSchema),
      importBooksyContext: (input: BooksyContextImport, reviewHash: string) =>
        client.post(
          "/appointments/booksy-context/import",
          { input, reviewHash },
          booksyContextReviewSchema,
        ),
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
      lookupUnlinkedAccount: (email: string) =>
        client.post("/admin/accounts/lookup", { email }, unlinkedAccountReviewSchema),
      setUnlinkedAccountRole: (input: ReviewedUnlinkedRoleInput) =>
        client.put("/admin/accounts/role/reviewed", input, changeRoleResponseSchema),
      emailDelivery: {
        get: (signal?: AbortSignal) =>
          client.get("/admin/email-delivery", emailDeliverySettingsSchema, { signal }),
        save: (input: EmailDeliveryInput) =>
          client.put("/admin/email-delivery", input, emailDeliverySettingsSchema),
        test: (revision: EmailDeliverySettings["revision"]) =>
          client.post(
            "/admin/email-delivery/test-reviewed",
            { revision },
            emailDeliveryTestReceiptSchema,
          ),
      },
      whatsapp: {
        get: (signal?: AbortSignal) =>
          client.get("/admin/whatsapp", whatsappSettingsSchema, { signal }),
        connect: (input: WhatsAppReviewedConnect) =>
          client.post("/admin/whatsapp/connect/reviewed", input, whatsappSettingsSchema),
        templates: () => client.get("/admin/whatsapp/templates", z.array(whatsappTemplateSchema)),
        deliveries: (signal?: AbortSignal) =>
          client.get("/admin/whatsapp/deliveries", whatsappDeliveriesSchema, { signal }),
        save: (input: WhatsAppReviewedRules) =>
          client.patch("/admin/whatsapp/rules/reviewed", input, whatsappSettingsSchema),
        disconnect: (input: WhatsAppReviewedDisconnect) =>
          client.post("/admin/whatsapp/disconnect/reviewed", input, whatsappSettingsSchema),
      },
      calendar: (
        query: Omit<CalendarQuery, "staffIds"> & { staffIds?: string[] },
        signal?: AbortSignal,
      ) =>
        client.get("/appointments/calendar", calendarResponseSchema, {
          signal,
          query: {
            from: query.from,
            to: query.to,
            staffIds: query.staffIds?.join(","),
            booksyPaymentReview: "1",
          },
        }),
      clients: {
        groups: () => client.get("/admin/clients/groups", clientGroupsSchema),
        create: (input: CreateClientRequest) =>
          client.post("/admin/clients", input, adminClientSchema),
        duplicates: (id: string) =>
          client.get(`/admin/clients/${id}/duplicates`, clientDuplicatesSchema),
        previewMerge: (input: ClientMergePair) =>
          client.post("/admin/clients/merge/preview", input, clientMergePreviewSchema),
        merge: (input: ClientMergeInput) =>
          client.post("/admin/clients/merge", input, clientMergeSchema),
        photos: (id: string) => client.get(`/admin/clients/${id}/photos`, clientPhotosSchema),
        uploadPhoto: (id: string, input: ClientPhotoUpload) =>
          client.post(`/admin/clients/${id}/photos`, input, clientPhotoSchema),
        updatePhoto: (id: string, photoId: string, input: ClientPhotoUpdate) =>
          client.patch(`/admin/clients/${id}/photos/${photoId}`, input, clientPhotoSchema),
        removePhoto: (id: string, photoId: string, version: number) =>
          client.delete(`/admin/clients/${id}/photos/${photoId}`, deletedAck, {
            query: { version },
          }),
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
        list: (signal?: AbortSignal) =>
          client.get("/admin/services", listAdminServicesResponseSchema, { signal }),
        create: (request: CreateServiceRequest) =>
          client.post("/admin/services", request, adminServiceSchema),
        update: (id: string, request: UpdateServiceRequest) =>
          client.patch(`/admin/services/${id}`, request, adminServiceSchema),
        deactivate: (id: string) => client.delete(`/admin/services/${id}`, adminServiceSchema),
        setStaff: (id: string, request: SetServiceStaffRequest) =>
          client.put(`/admin/services/${id}/staff`, request, adminServiceSchema),
      },
      staff: {
        savePortrait: (id: string, request: StaffPortraitInput) =>
          client.put(`/admin/staff/${id}/portrait`, request, staffPortraitResultSchema),
        publishPortrait: (id: string, request: StaffPortraitPublication) =>
          client.put(`/admin/staff/${id}/portrait/publication`, request, staffPortraitResultSchema),
        access: (id: string, signal?: AbortSignal) =>
          client.get(`/admin/staff/${id}/access/reviewed`, reviewedStaffAccessSchema, { signal }),
        setAccess: (id: string, body: ReviewedStaffAccessInput) =>
          client.put(`/admin/staff/${id}/access/reviewed`, body, reviewedStaffAccessSchema),
        setRole: (id: string, body: ReviewedStaffRoleInput) =>
          client.put(`/admin/staff/${id}/account-role/reviewed`, body, reviewedStaffAccessSchema),
        list: (signal?: AbortSignal) =>
          client.get("/admin/staff", listAdminStaffResponseSchema, { signal }),
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
      reports: (query: { from: string; to: string; staffId?: string; currency?: string }) =>
        client.get("/admin/reports/summary", reportSummarySchema, { query }),
      clientReport: (query: { from: string; to: string; staffId?: string }) =>
        client.get("/admin/reports/clients", reportClientsSchema, { query }),
      reportOutcomes: (query: ReportOutcomesQuery) =>
        client.get("/admin/reports/outcomes", reportOutcomesPageSchema, { query }),
      settings: {
        get: () => client.get("/admin/settings", ownerSalonSettingsSchema),
        reviewed: () => client.get("/admin/settings/desktop", desktopSalonSettingsSchema),
        saveProfile: (request: ReviewedBusinessProfileRequest) =>
          client.put("/admin/settings/profile", request, desktopSalonSettingsSchema),
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
