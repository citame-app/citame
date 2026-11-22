import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as C from "@sob/contracts";
import { Hono } from "hono";
import { z } from "zod";
import type { AppDeps } from "../app";
import { recordAudit } from "../audit";
import type { AppEnv, Principal } from "../auth/principal";
import { DomainError } from "../errors";
import { parseOrThrow, respondError } from "../http";
import { accountingRoutes } from "../modules/accounting/routes";
import { appointmentsRoutes } from "../modules/appointments/routes";
import { clientAdminRoutes } from "../modules/clients/admin-routes";
import { getIntakeRequirements } from "../modules/clients/intake";
import { commerceAdminRoutes } from "../modules/commerce/routes";
import { giftCardRoutes } from "../modules/gift-cards/routes";
import { inventoryRoutes } from "../modules/inventory/routes";
import { marketingAdminRoutes } from "../modules/marketing/routes";
import { passRoutes, planAdminRoutes } from "../modules/passes/routes";
import { reportRoutes } from "../modules/reports/routes";
import { resourceRoutes } from "../modules/resources/routes";
import { rewardsAdminRoutes } from "../modules/rewards/routes";
import { serviceAdminRoutes } from "../modules/services/admin-routes";
import { settingsAdminRoutes } from "../modules/settings/admin-routes";
import { staffAdminRoutes } from "../modules/staff/admin-routes";
import { waitlistAdminRoutes } from "../modules/waitlist/routes";
import { entryRow, entryView } from "../modules/waitlist/service";
import { notificationAdminRoutes } from "../notifications/routes";
import { whatsappAdminRoutes } from "../notifications/whatsapp/routes";
import { errorResult, toolFailure } from "./errors";
import type { ToolContext } from "./tools";

type InternalEnv = AppEnv & { Bindings: { principal: Principal } };
type Scope = (typeof C.MCP_MANAGEMENT_SCOPES)[number];
type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
type Operation = {
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
};
type Metadata = {
  scope: Scope;
  permission?: keyof C.StaffPermissions;
  owner?: true;
  destructive?: true;
  readOnly?: true;
  external?: true;
  idempotent?: true;
};

/**
 * Private in-process dispatch to the same route factories as the web API. Its principal lives
 * in Hono bindings supplied by the verifier, not in headers or the tool arguments. This router
 * is never mounted as a public endpoint. Only registered tools supply paths and HTTP methods.
 */
export function createManagementRouter(deps: AppDeps) {
  const app = new Hono<InternalEnv>();
  app.onError((error, c) => {
    if (error instanceof DomainError) return respondError(c, error);
    throw error;
  });
  app.use("*", async (c, next) => {
    c.set("principal", c.env.principal);
    await next();
  });
  return app
    .get("/waitlist-offer-review/:id", async (c) => {
      const { db, now = () => new Date() } = deps;
      const principal = c.get("principal");
      const entry = await entryRow(db, parseOrThrow(C.idSchema, c.req.param("id")), principal);
      const view = await entryView(db, entry, principal);
      const at = now();
      if (!view.canManage || !view.offer || Date.parse(view.offer.expiresAt) <= +at)
        throw new DomainError("invalid_state", "This entry has no active offer on your calendar");
      const intake = await getIntakeRequirements(
        db,
        entry.serviceIds,
        principal,
        at,
        entry.clientId,
      );
      return c.json({ entry: { ...view, offer: view.offer }, intake });
    })
    .route("/appointments", appointmentsRoutes(deps))
    .route("/staff", staffAdminRoutes(deps))
    .route("/services", serviceAdminRoutes(deps))
    .route("/waitlist", waitlistAdminRoutes(deps))
    .route("/clients", clientAdminRoutes(deps))
    .route("/resources", resourceRoutes(deps))
    .route("/inventory", inventoryRoutes(deps))
    .route("/commerce", commerceAdminRoutes(deps))
    .route("/reports", reportRoutes(deps))
    .route("/accounting", accountingRoutes(deps))
    .route("/settings", settingsAdminRoutes(deps))
    .route("/notifications", notificationAdminRoutes(deps))
    .route("/whatsapp", whatsappAdminRoutes(deps))
    .route("/plans", planAdminRoutes(deps))
    .route("/passes", passRoutes(deps))
    .route("/gift-cards", giftCardRoutes(deps))
    .route("/rewards", rewardsAdminRoutes(deps))
    .route("/marketing", marketingAdminRoutes(deps));
}

const read = (permission: keyof C.StaffPermissions): Metadata => ({
  scope: "operations:read",
  permission,
});
const schedule: Metadata = {
  scope: "schedule:write",
  permission: "editCalendar",
};
const catalog: Metadata = { scope: "catalog:write", permission: "editCatalog" };
const ownerCatalog: Metadata = { ...catalog, owner: true };
const clientWrite: Metadata = {
  scope: "clients:write",
  permission: "editClients",
};
const stock: Metadata = { scope: "stock:write", permission: "writeInventory" };
const settings: Metadata = { scope: "settings:write", owner: true };
const empty = z.strictObject({});
const id = z.strictObject({ id: C.idSchema });
const withBody = <S extends z.ZodType>(body: S) => z.strictObject({ id: C.idSchema, body });
const pageSize = z.number().int().min(1).max(50).default(20);
const client = C.adminClientSchema.omit({ notes: true, contactDetails: true });
const appointment = C.appointmentSchema.omit({ notes: true });
const seriesInput = z
  .strictObject({
    ...C.appointmentSeriesInputSchema.shape,
    clientId: C.idSchema,
  })
  .omit({
    client: true,
    notes: true,
    override: true,
    intakeResponses: true,
    protectionWaiverReason: true,
  });
const seriesCreate = seriesInput.extend({
  reviewHash: C.appointmentSeriesCreateSchema.shape.reviewHash,
  idempotencyKey: C.appointmentSeriesCreateSchema.shape.idempotencyKey,
});
const series = C.appointmentSeriesSchema.extend({ appointments: z.array(appointment) });
const timeOff = C.timeOffSchema.omit({ reason: true });
const calendar = C.calendarResponseSchema.extend({
  appointments: z.array(C.calendarAppointmentSchema.omit({ notes: true })),
  timeOff: z.array(timeOff),
});
const unpaidAppointments = C.unpaidAppointmentsSchema.extend({
  appointments: z.array(C.calendarAppointmentSchema.omit({ notes: true, serviceBadges: true })),
});
const stockLedger = C.stockLedgerSchema.extend({
  movements: C.stockLedgerSchema.shape.movements.element.omit({ reason: true }).array(),
});
const checkout = C.checkoutSchema.pick({
  id: true,
  appointmentId: true,
  clientId: true,
  staffId: true,
  currency: true,
  status: true,
  totalCents: true,
  paidCents: true,
  refundedCents: true,
  balanceCents: true,
  createdAt: true,
});
const checkoutList = C.checkoutListSchema.extend({
  checkouts: z.array(checkout),
});
const draftSale: Metadata = { scope: "sales:write", permission: "commerce", idempotent: true };
const ownerBilling: Metadata = {
  scope: "billing:write",
  owner: true,
  destructive: true,
  idempotent: true,
};
const importedSettlement = C.importedSettlementResponseSchema.extend({
  settlement: z
    .object(C.recordedImportedSettlementSchema.pick({ amountCents: true, recordedAt: true }).shape)
    .nullable(),
});
const commissions: Metadata = {
  scope: "commissions:write",
  permission: "manageCommissions",
  destructive: true,
};
const giftCard = C.giftCardSchema.omit({ codeRevision: true });
const commissionPayout = C.commissionPayoutSchema.omit({ reference: true });
const page = z.number().int().min(1).max(100000).default(1);
const waitlistEntry = C.waitlistEntrySchema.omit({ offer: true });
const waitlistOfferReview = z.object({
  entry: waitlistEntry.extend({ offer: C.waitlistOfferSchema }),
  intake: C.intakeRequirementsSchema.extend({
    forms: z.array(
      C.intakeRequirementsSchema.shape.forms.element.pick({ id: true }).extend({
        definition: z.object({
          title: z.string(),
          requiredAtBooking: z.boolean(),
        }),
      }),
    ),
  }),
});
const waitlistOfferAcceptance = C.waitlistAcceptSchema.omit({
  intakeResponses: true,
  protectionWaiverReason: true,
});
const waitlistOfferAccepted = C.waitlistAcceptedSchema.extend({
  entry: waitlistEntry,
  appointment,
});
const timeOffResult = C.timeOffResponseSchema.extend({ timeOff });
const waitlistList = C.waitlistListSchema.extend({
  entries: z.array(waitlistEntry),
});
const campaigns = C.campaignListSchema.extend({
  campaigns: z.array(
    C.campaignSchema.pick({
      id: true,
      name: true,
      status: true,
      channel: true,
      trigger: true,
      version: true,
    }),
  ),
});
const appointmentWrite = C.updateAppointmentRequestSchema;
const promotionWrite = C.promotionInputSchema.safeExtend({
  active: z.boolean(),
});
const staffWorkQuery = C.reportStaffWorkQuerySchema;
const staffWorkToolQuery = staffWorkQuery.safeExtend({
  from: staffWorkQuery.shape.from.describe(
    "First centre-local calendar date, inclusive (YYYY-MM-DD).",
  ),
  to: staffWorkQuery.shape.to.describe("Last centre-local calendar date, inclusive (YYYY-MM-DD)."),
  staffId: staffWorkQuery.shape.staffId.describe("UUID of the professional whose report to read."),
  currency: staffWorkQuery.shape.currency.describe(
    "Optional currency code. It does not change work durations.",
  ),
});

export function registerManagementTools(
  server: McpServer,
  ctx: ToolContext,
  router: ReturnType<typeof createManagementRouter>,
) {
  if (ctx.principal.role === "client") return;
  const permissions = C.permissionsFor(ctx.principal.role, ctx.principal.accessPreset);

  function add<I extends z.ZodObject, O extends z.ZodType>(
    name: string,
    description: string,
    gate: Metadata,
    method: Method,
    input: I,
    output: O,
    resolve: (args: z.output<I>) => Operation,
  ) {
    if (
      !ctx.scopes.includes(gate.scope) ||
      (gate.owner && ctx.principal.role !== "owner") ||
      (gate.permission && !permissions[gate.permission])
    )
      return;

    const readOnly = method === "GET" || gate.readOnly === true;
    server.registerTool<z.ZodObject, z.ZodObject>(
      name,
      {
        description,
        inputSchema: input,
        outputSchema: z.object({ data: output }),
        annotations: {
          readOnlyHint: readOnly,
          ...(!readOnly
            ? {
                destructiveHint: gate.destructive ?? false,
                idempotentHint: gate.idempotent ?? false,
              }
            : {}),
          openWorldHint: gate.external ?? false,
        },
      },
      async (args) => {
        try {
          // The SDK passes the validated output of the supplied input schema to this handler.
          const { path, query, body } = resolve(args as z.output<I>);
          const url = new URL(path, "https://citame-internal.invalid");
          for (const [key, value] of Object.entries(query ?? {})) {
            if (value !== undefined) url.searchParams.set(key, String(value));
          }
          if (!readOnly) {
            await recordAudit(ctx.db, {
              actorUserId: ctx.principal.userId,
              action: "mcp.write_requested",
              entity: "mcp_tool",
              metadata: {
                tool: name,
                oauthClientId: ctx.via.clientId,
                scope: gate.scope,
              },
            });
          }
          const response = await router.request(
            url,
            {
              method,
              ...(body !== undefined
                ? {
                    body: JSON.stringify(body),
                    headers: { "content-type": "application/json" },
                  }
                : {}),
            },
            { principal: ctx.principal },
          );
          const payload: unknown = await response.json();
          if (!response.ok) {
            const failure = C.errorResponseSchema.safeParse(payload);
            if (failure.success) return errorResult(failure.data.error);
            throw new Error("Invalid internal operation failure");
          }
          const parsed = output.safeParse(payload);
          if (!parsed.success) throw new Error(`Unexpected response contract for ${name}`);
          const data = { data: parsed.data };
          const text = JSON.stringify(data);
          if (text.length > 256 * 1024)
            throw new DomainError(
              "validation_error",
              "The result is too large. Narrow the date range or page size.",
            );
          return {
            structuredContent: data,
            content: [{ type: "text" as const, text }],
          };
        } catch (error) {
          return errorResult(toolFailure(error));
        }
      },
    );
  }

  add(
    "get_calendar",
    "Read appointments, comment indicators, working hours and unavailable intervals in the accessible calendar. Free-form notes are withheld.",
    read("editCalendar"),
    "GET",
    C.calendarQuerySchema,
    calendar,
    (query) => ({ path: "/appointments/calendar", query }),
  );
  add(
    "preview_appointment_series",
    "Review all dates, availability and price per visit for a recurring booking before asking for approval.",
    { ...read("editCalendar"), readOnly: true },
    "POST",
    seriesInput,
    C.appointmentSeriesPreviewSchema,
    (body) => ({ path: "/appointments/series/preview", body }),
  );
  add(
    "create_appointment_series",
    "Book the entire reviewed series using the same inputs and its review hash. A conflict leaves every occurrence unbooked. Reuse the same idempotency key for a retry.",
    { ...schedule, external: true, idempotent: true },
    "POST",
    seriesCreate,
    series,
    (body) => ({ path: "/appointments/series", body }),
  );
  add(
    "get_appointment_series",
    "Read a recurring booking in your accessible calendars, with private notes withheld.",
    read("editCalendar"),
    "GET",
    id,
    series,
    ({ id }) => ({ path: `/appointments/series/${id}` }),
  );
  add(
    "find_reschedule_availability",
    "Find available start times for an existing booking on one local date. Pass its original service IDs in the same order. Review the new time and professional before moving the booking.",
    read("editCalendar"),
    "GET",
    id.extend({
      serviceIds: z.array(C.idSchema).min(1).max(24),
      staffId: C.idSchema.optional(),
      date: C.localDateSchema,
    }),
    C.availabilityResponseSchema,
    ({ id, serviceIds, staffId, date }) => ({
      path: `/appointments/${id}/availability`,
      query: {
        date,
        serviceIds: serviceIds.join(","),
        staffId:
          staffId ?? (permissions.allCalendars ? undefined : (ctx.principal.staffId ?? undefined)),
      },
    }),
  );
  add(
    "update_appointment",
    "Move an appointment or record a visit outcome using its reviewed version. Confirm with the user before changing a booking; a move or cancellation can send a notice.",
    {
      ...schedule,
      destructive: true,
      external: true,
    },
    "PATCH",
    withBody(appointmentWrite),
    appointment,
    ({ id, body }) => ({ path: `/appointments/${id}`, body }),
  );

  add(
    "list_team",
    "List the centre team visible to this account.",
    read("editCalendar"),
    "GET",
    empty,
    C.listAdminStaffResponseSchema.extend({
      staff: z.array(C.adminStaffSchema.omit({ userId: true })),
    }),
    () => ({ path: "/staff" }),
  );
  add(
    "get_working_hours",
    "Read the regular hours of an accessible professional.",
    read("editCalendar"),
    "GET",
    id,
    C.workingHoursResponseSchema,
    ({ id }) => ({ path: `/staff/${id}/working-hours` }),
  );
  add(
    "get_staff_capacity",
    "Read the number of simultaneous appointments this professional can handle and its current version.",
    read("editCalendar"),
    "GET",
    id,
    C.staffCapacitySchema,
    ({ id }) => ({ path: `/staff/${id}/capacity` }),
  );
  add(
    "set_staff_capacity",
    "Set the maximum simultaneous appointments for a professional. Review the current capacity and confirm the change first.",
    { scope: "schedule:write", permission: "editSchedules", destructive: true },
    "PUT",
    withBody(C.staffCapacityInputSchema),
    C.staffCapacitySchema,
    ({ id, body }) => ({ path: `/staff/${id}/capacity`, body }),
  );
  add(
    "replace_working_hours",
    "Replace the complete weekly schedule for a professional. Review the current hours first. Existing appointments are reported as conflicts.",
    {
      ...schedule,
      owner: true,
      destructive: true,
    },
    "PUT",
    withBody(C.setWorkingHoursRequestSchema),
    C.workingHoursResponseSchema,
    ({ id, body }) => ({ path: `/staff/${id}/working-hours`, body }),
  );
  add(
    "list_time_off",
    "List existing staff calendar blocks.",
    read("editCalendar"),
    "GET",
    z.strictObject({ id: C.idSchema, query: C.listTimeOffQuerySchema }),
    C.listTimeOffResponseSchema.extend({ timeOff: z.array(timeOff) }),
    ({ id, query }) => ({ path: `/staff/${id}/time-off`, query }),
  );
  add(
    "create_time_off",
    "Block an interval on an accessible calendar. Existing appointments remain in place.",
    schedule,
    "POST",
    withBody(C.createTimeOffRequestSchema),
    timeOffResult,
    ({ id, body }) => ({ path: `/staff/${id}/time-off`, body }),
  );
  add(
    "list_date_shifts",
    "Read dated schedule exceptions for a professional.",
    read("editCalendar"),
    "GET",
    z.strictObject({ id: C.idSchema, query: C.dateShiftsQuerySchema }),
    C.dateShiftsResponseSchema,
    ({ id, query }) => ({ path: `/staff/${id}/date-shifts`, query }),
  );
  add(
    "preview_date_shifts",
    "Preview proposed schedule exceptions, impacted visits and offers. Return the review hash for a separately confirmed commit.",
    { ...schedule, readOnly: true },
    "POST",
    withBody(C.dateShiftInputSchema),
    C.dateShiftPreviewSchema,
    ({ id, body }) => ({ path: `/staff/${id}/date-shifts/preview`, body }),
  );
  add(
    "apply_date_shifts",
    "Apply reviewed schedule exceptions. Use the exact reviewed selection and hash. Ask for approval before withdrawing offers.",
    { ...schedule, destructive: true, idempotent: true },
    "POST",
    withBody(C.dateShiftCommitSchema),
    C.dateShiftResultSchema,
    ({ id, body }) => ({ path: `/staff/${id}/date-shifts`, body }),
  );
  const blockId = z.strictObject({ staffId: C.idSchema, blockId: C.idSchema });
  add(
    "update_time_off",
    "Edit an existing calendar block.",
    schedule,
    "PATCH",
    blockId.extend({ body: C.updateTimeOffRequestSchema }),
    timeOffResult,
    ({ staffId, blockId, body }) => ({
      path: `/staff/${staffId}/time-off/${blockId}`,
      body,
    }),
  );
  add(
    "remove_time_off",
    "Remove a calendar block and reopen the interval. Confirm the specific block with the user first.",
    { ...schedule, destructive: true },
    "DELETE",
    blockId,
    timeOffResult,
    ({ staffId, blockId }) => ({
      path: `/staff/${staffId}/time-off/${blockId}`,
    }),
  );

  add(
    "list_waitlist",
    "Read the active or historical waiting list. Offer secrets are withheld.",
    read("editCalendar"),
    "GET",
    C.waitlistQuerySchema,
    waitlistList,
    (query) => ({ path: "/waitlist", query }),
  );
  add(
    "add_waitlist_entry",
    "Add a customer to the waiting list with their date and time preferences.",
    schedule,
    "POST",
    C.waitlistAdminInputSchema,
    waitlistEntry,
    (body) => ({ path: "/waitlist", body }),
  );
  add(
    "cancel_waitlist_entry",
    "Cancel a waiting-list entry using its reviewed version.",
    { ...schedule, destructive: true },
    "POST",
    withBody(C.waitlistCancelSchema),
    waitlistEntry,
    ({ id, body }) => ({ path: `/waitlist/${id}/cancel`, body }),
  );
  add(
    "review_waitlist_offer",
    "Review the appointment quote, deposit policy, expiry and available saved form references for an entry from list_waitlist. Form answers are withheld.",
    read("editCalendar"),
    "GET",
    id,
    waitlistOfferReview,
    ({ id }) => ({ path: `/waitlist-offer-review/${id}` }),
  );
  add(
    "accept_waitlist_offer",
    "Book the exact slot and total from review_waitlist_offer after user approval. Reuse the same idempotency key on retry. Use the web desk for new form answers or deposit waivers.",
    { ...schedule, external: true, idempotent: true },
    "POST",
    withBody(waitlistOfferAcceptance),
    waitlistOfferAccepted,
    ({ id, body }) => ({ path: `/waitlist/${id}/accept`, body }),
  );
  add(
    "requeue_waitlist_offer",
    "Decline the reviewed offer and return its request to the waiting list for another match.",
    { ...schedule, destructive: true, external: true },
    "POST",
    withBody(C.waitlistDeclineSchema.omit({ requeue: true })),
    waitlistEntry,
    ({ id, body }) => ({
      path: `/waitlist/${id}/decline`,
      body: { ...body, requeue: true },
    }),
  );

  add(
    "list_clients",
    "Search and page through centre contacts. Internal notes and extended personal details are withheld.",
    read("clients"),
    "GET",
    C.clientListQuerySchema.extend({ pageSize }),
    C.listClientsResponseSchema.extend({ clients: z.array(client) }),
    (query) => ({ path: "/clients", query }),
  );
  add(
    "create_client",
    "Create a contact without signing up or sending an invitation. Reuse the same id for a retry.",
    { ...clientWrite, idempotent: true },
    "POST",
    C.createClientRequestSchema,
    client,
    (body) => ({ path: "/clients", body }),
  );
  add(
    "update_client",
    "Edit the contact profile. Changing versioned details requires its reviewed revision.",
    clientWrite,
    "PATCH",
    withBody(C.updateClientRequestSchema),
    client,
    ({ id, body }) => ({ path: `/clients/${id}`, body }),
  );

  add(
    "list_catalog_services",
    "Read the complete service catalogue, including inactive services and their current versions.",
    { ...read("editCatalog"), owner: true },
    "GET",
    empty,
    C.listAdminServicesResponseSchema,
    () => ({ path: "/services" }),
  );
  add(
    "create_service",
    "Create a service in the booking catalogue.",
    ownerCatalog,
    "POST",
    C.createServiceRequestSchema,
    C.adminServiceSchema,
    (body) => ({ path: "/services", body }),
  );
  add(
    "update_service",
    "Edit a service in the booking catalogue.",
    ownerCatalog,
    "PATCH",
    withBody(C.updateServiceRequestSchema),
    C.adminServiceSchema,
    ({ id, body }) => ({ path: `/services/${id}`, body }),
  );
  add(
    "configure_service",
    "Save a reviewed service configuration, including its professional assignments and optional variant or add-on settings, using the current version.",
    { ...ownerCatalog, destructive: true },
    "PUT",
    withBody(C.serviceConfigurationSchema),
    C.adminServiceSchema,
    ({ id, body }) => ({ path: `/services/${id}/configuration`, body }),
  );
  const combination = C.serviceCombinationSchema.omit({ description: true });
  add(
    "list_service_combinations",
    "Read the saved treatment combinations, including inactive ones, their ordered service IDs and current versions.",
    { ...read("editCatalog"), owner: true },
    "GET",
    empty,
    z.object({ combinations: z.array(combination) }),
    () => ({ path: "/services/combinations" }),
  );
  add(
    "create_service_combination",
    "Create a reviewed treatment combination. Preserve the selected service order and reuse the idempotency key on a retry.",
    { ...ownerCatalog, idempotent: true },
    "POST",
    C.combinationCreateSchema,
    combination,
    (body) => ({ path: "/services/combinations", body }),
  );
  add(
    "update_service_combination",
    "Replace a treatment combination or change its active status using the version last reviewed by the operator.",
    { ...ownerCatalog, destructive: true },
    "PUT",
    withBody(C.combinationUpdateSchema),
    combination,
    ({ id, body }) => ({ path: `/services/combinations/${id}`, body }),
  );
  add(
    "get_service_resources",
    "Read the rooms and equipment required by a service, including the current version.",
    { ...read("editCatalog"), owner: true },
    "GET",
    id,
    C.serviceResourcesSchema,
    ({ id }) => ({ path: `/services/${id}/resources` }),
  );
  add(
    "set_service_resources",
    "Replace the rooms and equipment requirements for a service using its reviewed version.",
    { ...ownerCatalog, destructive: true },
    "PUT",
    withBody(C.serviceResourceInputSchema),
    C.serviceResourcesSchema,
    ({ id, body }) => ({ path: `/services/${id}/resources`, body }),
  );
  add(
    "set_service_processing",
    "Change a service's processing interval using its reviewed version. Review its effect on future availability first.",
    { ...ownerCatalog, destructive: true },
    "PUT",
    withBody(C.serviceProcessingInputSchema),
    C.adminServiceSchema,
    ({ id, body }) => ({ path: `/services/${id}/processing`, body }),
  );
  add(
    "assign_service_staff",
    "Replace the professional assignments for one service. Review the complete selection first.",
    { ...ownerCatalog, destructive: true },
    "PUT",
    withBody(C.setServiceStaffRequestSchema),
    C.adminServiceSchema,
    ({ id, body }) => ({ path: `/services/${id}/staff`, body }),
  );
  add(
    "update_staff_profile",
    "Edit an existing professional's display profile and availability status.",
    { ...ownerCatalog, destructive: true },
    "PATCH",
    withBody(C.updateStaffRequestSchema),
    C.adminStaffSchema.omit({ userId: true }),
    ({ id, body }) => ({ path: `/staff/${id}`, body }),
  );
  add(
    "list_resources",
    "Read physical resources and room capacity.",
    read("editCatalog"),
    "GET",
    empty,
    C.resourceListSchema,
    () => ({ path: "/resources" }),
  );
  add(
    "create_resource",
    "Add a room, station or equipment resource.",
    catalog,
    "POST",
    C.resourceCreateSchema,
    C.resourceSchema,
    (body) => ({ path: "/resources", body }),
  );
  add(
    "update_resource",
    "Change a physical resource using its reviewed version.",
    catalog,
    "PUT",
    withBody(C.resourceUpdateSchema),
    C.resourceSchema,
    ({ id, body }) => ({ path: `/resources/${id}`, body }),
  );

  add(
    "list_products",
    "Search products and current quantities. Cost fields follow the user's inventory permissions.",
    read("readInventory"),
    "GET",
    C.productQuerySchema.extend({
      pageSize,
      lowStock: z.boolean().optional(),
      resellable: z.boolean().optional(),
    }),
    C.productListSchema,
    (query) => ({ path: "/inventory/products", query }),
  );
  add(
    "get_product",
    "Review a product, current quantities, version and server generation before adjusting stock.",
    read("readInventory"),
    "GET",
    z.object({ id: C.idSchema }),
    C.reviewedInventoryProductSchema,
    ({ id }) => ({ path: `/inventory/products/${id}` }),
  );
  add(
    "list_stock_movements",
    "Read the stock ledger by movement type or product. Free-form reasons are withheld.",
    read("readInventory"),
    "GET",
    C.stockLedgerQuerySchema.extend({ pageSize }),
    stockLedger,
    (query) => ({ path: "/inventory/movements", query }),
  );
  add(
    "create_product",
    "Add a product to the inventory catalogue.",
    stock,
    "POST",
    C.createProductSchema,
    C.productSchema,
    (body) => ({ path: "/inventory/products", body }),
  );
  add(
    "update_product",
    "Update a product using its reviewed version.",
    stock,
    "PATCH",
    withBody(C.updateProductSchema),
    C.productSchema,
    ({ id, body }) => ({ path: `/inventory/products/${id}`, body }),
  );
  add(
    "record_stock_movement",
    "Record a delivery, internal consumption or physical count. Read get_product first and use its version and inventoryGeneration. Retry with the original key and values.",
    {
      ...stock,
      destructive: true,
      idempotent: true,
    },
    "POST",
    withBody(C.stockMovementInputSchema),
    C.reviewedInventoryProductSchema,
    ({ id, body }) => ({ path: `/inventory/products/${id}/movements`, body }),
  );

  add(
    "list_sales",
    "Read sales and balances the current account can see. Payment references and line details are withheld.",
    read("commerce"),
    "GET",
    C.checkoutListQuerySchema.safeExtend({ pageSize }),
    checkoutList,
    (query) => ({ path: "/commerce/checkouts", query }),
  );
  add(
    "list_unpaid_appointments",
    "Find appointments eligible for checkout over a calendar period. Review the booking before preparing a checkout.",
    read("commerce"),
    "GET",
    C.calendarQuerySchema,
    unpaidAppointments,
    (query) => ({ path: "/commerce/unpaid", query }),
  );
  add(
    "get_imported_price_review",
    "Read the current version and unresolved service lines for one imported appointment. Ask the owner to verify the actual amount for every line using the original quote or another reliable record.",
    { ...read("commerce"), owner: true },
    "GET",
    id,
    C.importedPriceReviewPreviewSchema,
    ({ id }) => ({ path: `/commerce/appointments/${id}/imported-price` }),
  );
  add(
    "record_imported_price_review",
    "Save amounts verified by the owner for every unresolved service line of a booking. Confirm the amounts and source with the owner before saving. This does not create a checkout, issue an invoice or record a payment.",
    ownerBilling,
    "PUT",
    withBody(C.importedPriceReviewSchema),
    z.object({ ok: z.literal(true) }),
    ({ id, body }) => ({ path: `/commerce/appointments/${id}/imported-price`, body }),
  );
  add(
    "get_imported_settlement",
    "Read the appointment version and any full payment already reconciled from Booksy. Use the source record to verify a payment before recording it.",
    { ...read("commerce"), owner: true },
    "GET",
    id,
    importedSettlement,
    ({ id }) => ({ path: `/commerce/appointments/${id}/imported-settlement` }),
  );
  add(
    "record_imported_settlement",
    "Record a verified full payment already made in Booksy. Confirm the appointment, full amount in euro cents and source evidence with the owner before saving. Citame will close the appointment to checkout.",
    ownerBilling,
    "PUT",
    withBody(C.importedSettlementSchema),
    importedSettlement,
    ({ id, body }) => ({ path: `/commerce/appointments/${id}/imported-settlement`, body }),
  );
  add(
    "get_imported_partial_payment",
    "Read the version and original euro total of an eligible Booksy appointment, or the amounts already reconciled and still due. Use the source record to verify the instalment.",
    { ...read("commerce"), owner: true },
    "GET",
    id,
    C.importedPartialPaymentPreviewSchema,
    ({ id }) => ({ path: `/commerce/appointments/${id}/imported-partial-payment` }),
  );
  add(
    "record_imported_partial_payment",
    "Record an instalment already paid in Booksy. Confirm the appointment, paid amount in euro cents and source evidence with the owner. Citame will leave only the remaining balance collectible.",
    ownerBilling,
    "PUT",
    withBody(C.importedPartialPaymentSchema),
    C.importedPartialPaymentResponseSchema,
    ({ id, body }) => ({ path: `/commerce/appointments/${id}/imported-partial-payment`, body }),
  );
  add(
    "get_checkout",
    "Read a checkout's totals, amount paid and remaining balance.",
    read("commerce"),
    "GET",
    id,
    checkout,
    ({ id }) => ({ path: `/commerce/checkouts/${id}` }),
  );
  add(
    "create_checkout_draft",
    "Prepare a checkout draft from the catalogue or appointment. This tool does not accept or charge a payment.",
    draftSale,
    "POST",
    z.strictObject({ body: C.createCheckoutSchema }),
    checkout,
    ({ body }) => ({ path: "/commerce/checkouts", body }),
  );
  add(
    "void_checkout_draft",
    "Discard an unpaid checkout draft and release its reservations. Review the checkout with the operator first. This does not refund a payment.",
    { ...draftSale, destructive: true },
    "POST",
    id,
    checkout,
    ({ id }) => ({ path: `/commerce/checkouts/${id}/void` }),
  );
  const cash = C.cashSessionSchema.omit({ movements: true });
  add(
    "get_cash_session",
    "Read the current cash session totals.",
    read("manageCash"),
    "GET",
    empty,
    z.object({ session: cash.nullable() }),
    () => ({ path: "/commerce/cash-sessions/current" }),
  );
  const cashWrite: Metadata = {
    scope: "cash:write",
    permission: "manageCash",
    destructive: true,
  };
  add(
    "record_cash_movement",
    "Record a confirmed physical cash deposit or withdrawal. Use the reviewed session ID from get_cash_session and reuse the key for a retry of the same movement.",
    { ...cashWrite, idempotent: true },
    "POST",
    C.cashAdjustmentSchema.extend({ sessionId: C.idSchema }),
    cash,
    (body) => ({ path: "/commerce/cash-sessions/adjust", body }),
  );
  add(
    "open_cash_session",
    "Open the cash session with physical cash counted by the operator. Confirm the amount and pass a stable session ID for safe retries.",
    cashWrite,
    "POST",
    C.cashOpenSchema,
    cash,
    (body) => ({ path: "/commerce/cash-sessions", body }),
  );
  add(
    "close_cash_session",
    "Close the cash session with the physical count. Confirm the session and amount, and pass its reviewed expected balance to detect intervening movements.",
    cashWrite,
    "POST",
    withBody(C.cashCloseSchema),
    cash,
    ({ id, body }) => ({ path: `/commerce/cash-sessions/${id}/close`, body }),
  );
  add(
    "record_received_payment",
    "Record cash or a payment already collected outside Citame. Never use this to charge a card. Confirm the checkout, amount and method with the operator and reuse the key for retries.",
    { ...cashWrite, idempotent: true },
    "POST",
    withBody(
      z.strictObject({
        method: z.enum(["cash", "external_card"]),
        amountCents: C.moneyCentsSchema.refine((amount) => amount > 0),
        idempotencyKey: C.idempotencyKeySchema,
      }),
    ),
    z.object({
      payment: C.startedPaymentSchema.shape.payment.omit({ order: true }),
    }),
    ({ id, body }) => ({ path: `/commerce/checkouts/${id}/payments`, body }),
  );
  add(
    "get_operating_report",
    "Read appointment and utilisation totals for the requested period.",
    read("operationalReports"),
    "GET",
    C.reportQuerySchema,
    C.reportSummarySchema,
    (query) => ({ path: "/reports/summary", query }),
  );
  add(
    "get_staff_work_report",
    "Read one professional's daily scheduled, blocked and reserved minutes and unavailable intervals for a date range and the next 14 days. Staff without team calendar access can only read their own report.",
    read("operationalReports"),
    "GET",
    staffWorkToolQuery,
    C.reportStaffWorkSchema,
    (query) => ({ path: "/reports/staff-work", query }),
  );
  add(
    "get_sales_report",
    "Read financial sales aggregates for a date range.",
    read("financialReports"),
    "GET",
    C.reportQuerySchema,
    C.salesReportSchema,
    (query) => ({ path: "/accounting/sales", query }),
  );
  add(
    "get_commission_policy",
    "Read the service and product commission rates and the policy version for a professional.",
    read("commerce"),
    "GET",
    id,
    C.commissionPolicySchema,
    ({ id }) => ({ path: `/accounting/staff/${id}/policy` }),
  );
  add(
    "get_commission_statement",
    "Read one professional's commission balance and paginated accruals and payment records.",
    read("commerce"),
    "GET",
    id.extend({ page, payoutPage: page }),
    C.commissionStatementSchema.extend({ payouts: z.array(commissionPayout) }),
    ({ id, ...query }) => ({ path: `/accounting/staff/${id}/statement`, query }),
  );
  add(
    "update_commission_policy",
    "Replace commission rates for future accruals using the reviewed policy version. Confirm the professional and both rates first.",
    commissions,
    "PUT",
    withBody(C.commissionPolicyInputSchema),
    C.commissionPolicySchema,
    ({ id, body }) => ({ path: `/accounting/staff/${id}/policy`, body }),
  );
  add(
    "record_commission_payout",
    "Record a commission payout already made outside Citame. Confirm the professional, amount and payment reference with the operator and reuse the key for retries.",
    { ...commissions, idempotent: true },
    "POST",
    withBody(C.commissionPayoutInputSchema),
    commissionPayout,
    ({ id, body }) => ({ path: `/accounting/staff/${id}/payouts`, body }),
  );
  add(
    "list_benefit_plans",
    "Read the centre's package and membership plans.",
    read("editCatalog"),
    "GET",
    empty,
    C.benefitPlanListSchema,
    () => ({ path: "/plans" }),
  );
  add(
    "create_benefit_plan",
    "Create package or membership terms without selling the plan.",
    catalog,
    "POST",
    C.createBenefitPlanSchema,
    C.benefitPlanSchema,
    (body) => ({ path: "/plans", body }),
  );
  add(
    "update_benefit_plan",
    "Change the terms of an existing benefit plan.",
    catalog,
    "PATCH",
    withBody(C.updateBenefitPlanSchema),
    C.benefitPlanSchema,
    ({ id, body }) => ({ path: `/plans/${id}`, body }),
  );
  add(
    "list_passes",
    "Read issued packages and subscriptions accessible to the current account.",
    read("commerce"),
    "GET",
    C.passQuerySchema,
    C.passListSchema,
    (query) => ({ path: "/passes", query }),
  );
  add(
    "get_pass",
    "Read a package or membership with its uses, balance and current state.",
    read("commerce"),
    "GET",
    id,
    C.passContractSchema,
    ({ id }) => ({ path: `/passes/${id}` }),
  );
  add(
    "list_pass_periods",
    "Read one page of a package or membership's periods and remaining uses.",
    read("commerce"),
    "GET",
    id.extend({ page }),
    C.passPeriodsSchema,
    ({ id, page }) => ({ path: `/passes/${id}/periods`, query: { page } }),
  );
  add(
    "create_pass_sale_draft",
    "Prepare a package or manual-renewal membership sale for a named client. Confirm the current plan version and reuse the key for retries.",
    draftSale,
    "POST",
    z.strictObject({
      clientId: C.idSchema,
      planId: C.idSchema,
      planVersion: z.number().int().positive(),
      idempotencyKey: C.idempotencyKeySchema,
    }),
    C.passPurchaseResponseSchema.extend({ checkout }),
    (body) => ({ path: "/passes", body: { ...body, renewalMode: "manual" } }),
  );
  add(
    "list_gift_cards",
    "Read gift card status and balances; redemption codes are withheld.",
    read("commerce"),
    "GET",
    C.giftCardQuerySchema,
    C.giftCardListSchema.extend({ cards: z.array(giftCard) }),
    (query) => ({ path: "/gift-cards", query }),
  );
  add(
    "get_gift_card",
    "Read a gift card's status, expiry and balance by its record ID.",
    read("commerce"),
    "GET",
    id,
    giftCard,
    ({ id }) => ({ path: `/gift-cards/${id}` }),
  );
  add(
    "list_gift_card_movements",
    "Read paginated gift-card activations, redemptions and reversals.",
    read("commerce"),
    "GET",
    id.extend({ page }),
    C.giftCardMovementListSchema,
    ({ id, page }) => ({ path: `/gift-cards/${id}/movements`, query: { page } }),
  );
  add(
    "create_gift_card_sale_draft",
    "Prepare a gift-card sale without issuing a usable card. Confirm the value, buyer and expiry with the operator and reuse the key for retries.",
    draftSale,
    "POST",
    C.giftCardPurchaseSchema,
    C.giftCardPurchaseResponseSchema.extend({ card: giftCard, checkout }),
    (body) => ({ path: "/gift-cards", body }),
  );
  add(
    "get_loyalty_policy",
    "Read the centre's rules for earning, redeeming and expiring loyalty points.",
    { scope: "operations:read", owner: true },
    "GET",
    empty,
    C.loyaltyPolicySchema,
    () => ({ path: "/rewards/policy" }),
  );
  add(
    "update_loyalty_policy",
    "Update the versioned loyalty rules after confirming their effect on future sales.",
    { ...settings, destructive: true },
    "PUT",
    C.loyaltyPolicyInputSchema,
    C.loyaltyPolicySchema,
    (body) => ({ path: "/rewards/policy", body }),
  );
  add(
    "get_client_loyalty",
    "Read a permitted client's points balance and a page of movements.",
    read("clients"),
    "GET",
    z.strictObject({
      id: C.idSchema,
      page: z.number().int().min(1).max(100000).optional(),
    }),
    C.loyaltyStatementSchema,
    ({ id, page }) => ({ path: `/rewards/clients/${id}`, query: { page } }),
  );
  add(
    "list_promotions",
    "Read checkout promotion terms, restrictions and usage counts.",
    read("editCatalog"),
    "GET",
    z.strictObject({
      page: z.number().int().min(1).max(100000).optional(),
      search: z.string().trim().max(100).optional(),
    }),
    z.object({
      promotions: z.array(C.promotionSchema),
      pagination: C.pageInfoSchema,
    }),
    (query) => ({ path: "/rewards/promotions", query }),
  );
  add(
    "create_promotion",
    "Create checkout discount terms. Check the price, eligibility and dates with the operator before enabling a promotion.",
    { ...catalog, destructive: true, idempotent: true },
    "POST",
    promotionWrite,
    C.promotionSchema,
    (body) => ({ path: "/rewards/promotions", body }),
  );
  add(
    "update_promotion",
    "Edit a checkout promotion using the version reviewed by the operator.",
    { ...catalog, destructive: true },
    "PUT",
    withBody(promotionWrite),
    C.promotionSchema,
    ({ id, body }) => ({ path: `/rewards/promotions/${id}`, body }),
  );
  add(
    "list_campaigns",
    "Read campaign names, channels and statuses. This tool does not send or schedule campaigns.",
    read("editCatalog"),
    "GET",
    C.campaignQuerySchema,
    campaigns,
    (query) => ({ path: "/marketing/campaigns", query }),
  );
  const campaign = C.campaignSchema.pick({
    id: true,
    name: true,
    status: true,
    channel: true,
    trigger: true,
    version: true,
  });
  add(
    "create_campaign_draft",
    "Create an unqueued marketing draft. The dashboard controls audience review and sending.",
    { ...catalog, idempotent: true },
    "POST",
    C.campaignCreateSchema,
    campaign,
    (body) => ({ path: "/marketing/campaigns", body }),
  );
  add(
    "update_campaign_draft",
    "Edit an existing draft using its reviewed version. This cannot queue delivery.",
    catalog,
    "PATCH",
    withBody(C.campaignUpdateSchema),
    campaign,
    ({ id, body }) => ({ path: `/marketing/campaigns/${id}`, body }),
  );
  add(
    "get_waitlist_policy",
    "Read the current waiting-list configuration.",
    read("editCalendar"),
    "GET",
    empty,
    C.waitlistListSchema.pick({ policy: true }),
    () => ({ path: "/waitlist", query: { pageSize: 1 } }),
  );
  add(
    "update_waitlist_policy",
    "Change the versioned waiting-list rules and offer duration.",
    { ...settings, destructive: true },
    "PUT",
    C.waitlistPolicySchema,
    C.waitlistPolicySchema,
    (body) => ({ path: "/waitlist/policy", body }),
  );
  add(
    "get_booking_policy",
    "Read deposit and cancellation rules with the generation and version needed to review a change.",
    { scope: "operations:read", owner: true },
    "GET",
    empty,
    C.reviewedBookingPolicySchema,
    () => ({ path: "/settings/booking-policy/reviewed" }),
  );
  add(
    "update_booking_policy",
    "Change the versioned deposit or cancellation policy for future bookings. Confirm the terms with the owner.",
    { ...settings, destructive: true },
    "PUT",
    z.strictObject({ body: C.reviewedBookingPolicyInputSchema }),
    C.reviewedBookingPolicySchema,
    ({ body }) => ({ path: "/settings/booking-policy/reviewed", body }),
  );
  add(
    "get_centre_settings",
    "Read owner-only calendar and reminder settings.",
    { scope: "operations:read", owner: true },
    "GET",
    empty,
    C.ownerSalonSettingsSchema,
    () => ({ path: "/settings" }),
  );
  add(
    "update_centre_settings",
    "Update booking limits, timezone or reminder timing. Confirm changes that affect future appointments.",
    { ...settings, destructive: true },
    "PATCH",
    z.strictObject({ body: C.updateSalonSettingsRequestSchema }),
    C.ownerSalonSettingsSchema,
    ({ body }) => ({ path: "/settings", body }),
  );
  add(
    "list_calendar_notices",
    "List new, moved or cancelled appointments visible in the current user's notification inbox.",
    read("editCalendar"),
    "GET",
    C.calendarInboxQuerySchema.extend({ archived: z.boolean().optional() }),
    C.calendarInboxSchema,
    (query) => ({ path: "/notifications/inbox", query }),
  );
  add(
    "set_calendar_notices_archived",
    "Archive or restore selected notices in the current user's inbox. This never changes the appointment.",
    { ...schedule, idempotent: true },
    "POST",
    C.calendarArchiveInputSchema,
    z.object({ ok: z.literal(true) }),
    (body) => ({ path: "/notifications/inbox/archive", body }),
  );
  add(
    "get_notification_stats",
    "Read queue counts and provider availability without recipient or message details.",
    { scope: "operations:read", owner: true },
    "GET",
    empty,
    C.notificationStatsSchema,
    () => ({ path: "/notifications/stats" }),
  );
  add(
    "get_whatsapp_settings",
    "Read the current sender status and appointment notification rules without connection credentials.",
    { scope: "operations:read", owner: true },
    "GET",
    empty,
    C.whatsappSettingsSchema.omit({ setup: true }),
    () => ({ path: "/whatsapp" }),
  );
  add(
    "list_whatsapp_templates",
    "List approved utility template names, languages and supported variables.",
    { scope: "operations:read", owner: true, external: true },
    "GET",
    empty,
    z.array(C.whatsappTemplateSchema),
    () => ({ path: "/whatsapp/templates" }),
  );
  add(
    "update_whatsapp_rules",
    "Replace WhatsApp appointment automation rules. Saving can schedule future notifications for opted-in clients. Get explicit confirmation first.",
    {
      ...settings,
      destructive: true,
      external: true,
    },
    "PATCH",
    z.strictObject({ rules: C.whatsappRulesSchema }),
    C.whatsappSettingsSchema.omit({ setup: true }),
    ({ rules }) => ({ path: "/whatsapp/rules", body: rules }),
  );
}
