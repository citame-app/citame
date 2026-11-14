import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type CalendarQuery,
  type CreateAppointmentRequest,
  createAppointmentRequestSchema,
  MCP_PAGE_SIZE_DEFAULT,
  MCP_TOOL_SCOPES,
  type McpToolName,
  mcpCancelAppointmentInput,
  mcpCancelAppointmentOutput,
  mcpCreateAppointmentInput,
  mcpCreateAppointmentOutput,
  mcpFindAvailabilityInput,
  mcpFindAvailabilityOutput,
  mcpFindClientInput,
  mcpFindClientOutput,
  mcpListMyAppointmentsInput,
  mcpListMyAppointmentsOutput,
  mcpListScheduleInput,
  mcpListScheduleOutput,
  mcpListServicesInput,
  mcpListServicesOutput,
  type OAuthScope,
} from "@sob/contracts";
import { appointment, type Database } from "@sob/db";
import { and, eq, isNull } from "drizzle-orm";
import type { z } from "zod";
import {
  authorizeAppointmentChange,
  authorizeAppointmentCreate,
  authorizeAppointmentList,
  authorizeCalendarQuery,
  authorizeClientAccess,
} from "../auth/policy";
import type { Principal } from "../auth/principal";
import { DomainError } from "../errors";
import { parseOrThrow } from "../http";
import { getCalendar } from "../modules/appointments/calendar";
import {
  createAppointment,
  getAppointmentOwnership,
  listAppointments,
  loadSnapshots,
  toAppointment,
  updateAppointment,
} from "../modules/appointments/service";
import { findAvailability } from "../modules/availability/service";
import { listClients } from "../modules/clients/admin";
import { listServices } from "../modules/services/service";
import { listStaff } from "../modules/staff/service";
import { errorResult, toolFailure } from "./errors";

export interface ToolContext {
  db: Database;
  principal: Principal;
  scopes: readonly OAuthScope[];
  now: () => Date;
  /** Recorded in the audit log of every write, so a booking made by an agent says so. */
  via: { channel: "mcp"; clientId: string };
}

const DAY_MS = 86_400_000;
const DEFAULT_WINDOW_DAYS = 90;

/**
 * Appointment notes are free text typed by clients. A front-desk agent reading them would be
 * reading attacker-controlled instructions (prompt injection), so staff and owner tokens get the
 * notes redacted; a client always sees their own. The REST API and the dashboard are unchanged:
 * a person reading a note is not an agent obeying it.
 */
function redactNotes<T extends { notes: string | null }>(principal: Principal, row: T): T {
  return principal.role === "client" ? row : { ...row, notes: null };
}

function ok<T extends Record<string, unknown>>(output: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(output) }],
    structuredContent: output,
  };
}

/**
 * Runs a tool body under the shared guard: the token must carry the tool's scope, then the body
 * runs with every domain failure converted to an agent-readable tool error. Scope is checked
 * here and role is checked by the same policy functions the REST routes use.
 */
function guarded<Args, Out extends Record<string, unknown>>(
  ctx: ToolContext,
  tool: McpToolName,
  body: (args: Args) => Promise<Out>,
) {
  return async (args: Args) => {
    const required = MCP_TOOL_SCOPES[tool];
    if (!ctx.scopes.includes(required)) {
      return errorResult({
        code: "forbidden",
        message: `This access token was not granted the "${required}" scope that ${tool} needs. Ask the user to reconnect and approve it`,
      });
    }
    try {
      return ok(await body(args));
    } catch (error) {
      return errorResult(toolFailure(error));
    }
  };
}

/**
 * Registers the tools a principal may use. Staff-only tools are not advertised to clients: a
 * model should not see (and try) tools that can only fail. They are still guarded on every call
 * by the policy layer, so hiding is a usability measure, not the access control.
 */
export function registerTools(server: McpServer, ctx: ToolContext): void {
  const { db, principal } = ctx;
  const frontDesk = principal.role === "owner" || principal.role === "staff";

  server.registerTool(
    "list_services",
    {
      title: "List services and professionals",
      description:
        "Lists the services the salon offers (with duration and price) and the professionals who can be booked. Start here: the ids returned are needed by find_availability and create_appointment.",
      inputSchema: mcpListServicesInput.shape,
      outputSchema: mcpListServicesOutput.shape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(ctx, "list_services", async () => ({
      services: await listServices(db),
      staff: await listStaff(db),
    })),
  );

  server.registerTool(
    "find_availability",
    {
      title: "Find available appointment times",
      description:
        "Returns the free start times on one day for the given services, optionally for one professional. Times are advisory: another booking can take a slot before you book it, in which case create_appointment reports it.",
      inputSchema: mcpFindAvailabilityInput.shape,
      outputSchema: mcpFindAvailabilityOutput.shape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(ctx, "find_availability", async (args: z.infer<typeof mcpFindAvailabilityInput>) =>
      findAvailability(db, args, ctx.now()),
    ),
  );

  server.registerTool(
    "list_my_appointments",
    {
      title: "List appointments",
      description:
        "Lists appointments in a time window. Clients see only their own. Staff see their own calendar. The owner sees every appointment.",
      inputSchema: mcpListMyAppointmentsInput.shape,
      outputSchema: mcpListMyAppointmentsOutput.shape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(
      ctx,
      "list_my_appointments",
      async (args: z.infer<typeof mcpListMyAppointmentsInput>) => {
        const from = args.from ?? ctx.now().toISOString();
        const to =
          args.to ?? new Date(Date.parse(from) + DEFAULT_WINDOW_DAYS * DAY_MS).toISOString();
        if (Date.parse(to) <= Date.parse(from)) {
          throw new DomainError("validation_error", "`to` must be after `from`");
        }
        const scoped = authorizeAppointmentList(principal, {
          from,
          to,
          status: args.status,
          page: args.page,
          pageSize: args.pageSize ?? MCP_PAGE_SIZE_DEFAULT,
        });
        const result = await listAppointments(db, scoped.query, { clientId: scoped.clientId });
        return {
          ...result,
          appointments: result.appointments.map((a) => redactNotes(principal, a)),
        };
      },
    ),
  );

  server.registerTool(
    "create_appointment",
    {
      title: "Book an appointment",
      description:
        "Books an appointment at a start time returned by find_availability. Clients book for themselves; staff and owners must pass clientId (use find_client). Pass a requestId you generate so a retry after a timeout cannot double-book. Fails with an actionable error if the slot was just taken.",
      inputSchema: mcpCreateAppointmentInput.shape,
      outputSchema: mcpCreateAppointmentOutput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    guarded(ctx, "create_appointment", async (args: z.infer<typeof mcpCreateAppointmentInput>) => {
      const { requestId, ...rest } = args;
      if (principal.role === "client" && rest.clientId !== undefined) {
        // A model must not be able to even try to book for someone else.
        throw new DomainError("forbidden", "You can only book appointments for yourself");
      }
      // Staff and owners must name the client: reuse the REST contract for that rule.
      const candidate = { ...rest, id: requestId };
      const request: CreateAppointmentRequest =
        principal.role === "client"
          ? ({ ...candidate } as CreateAppointmentRequest)
          : parseOrThrow(createAppointmentRequestSchema, candidate);
      const authorized = authorizeAppointmentCreate(principal, request);
      const actor = { userId: principal.userId, via: ctx.via };
      try {
        const created = await createAppointment(db, authorized, actor, { now: ctx.now() });
        return { appointment: redactNotes(principal, created), replayed: false };
      } catch (error) {
        // The same requestId again: return the booking it already made, if it is this caller's.
        if (requestId && error instanceof DomainError && error.code === "invalid_state") {
          const existing = await findOwnedReplay(ctx, requestId, authorized);
          if (existing) return { appointment: redactNotes(principal, existing), replayed: true };
          throw new DomainError(
            "validation_error",
            "This requestId was already used. Generate a new one",
          );
        }
        throw error;
      }
    }),
  );

  server.registerTool(
    "cancel_appointment",
    {
      title: "Cancel an appointment",
      description:
        "Cancels a booked appointment. This frees the time slot and cannot be undone. Clients can cancel only their own appointments.",
      inputSchema: mcpCancelAppointmentInput.shape,
      outputSchema: mcpCancelAppointmentOutput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guarded(ctx, "cancel_appointment", async (args: z.infer<typeof mcpCancelAppointmentInput>) => {
      const ownership = await getAppointmentOwnership(db, args.appointmentId);
      try {
        authorizeAppointmentChange(principal, ownership, { status: "cancelled", version: 1 });
      } catch (error) {
        // Same answer as for an unknown id: a client must not learn that an id exists.
        if (principal.role === "client" && error instanceof DomainError) {
          throw new DomainError("not_found", `Appointment ${args.appointmentId} not found`);
        }
        throw error;
      }
      const [current] = await db
        .select({ version: appointment.version })
        .from(appointment)
        .where(and(eq(appointment.id, args.appointmentId), isNull(appointment.deletedAt)));
      if (!current)
        throw new DomainError("not_found", `Appointment ${args.appointmentId} not found`);
      const cancelled = await updateAppointment(
        db,
        args.appointmentId,
        { status: "cancelled", version: current.version },
        { userId: principal.userId, via: ctx.via },
        { now: ctx.now() },
      );
      return { appointment: redactNotes(principal, cancelled) };
    }),
  );

  if (!frontDesk) return;

  server.registerTool(
    "list_schedule",
    {
      title: "Read the staff schedule",
      description:
        "Staff and owners only. Lists appointments with client names and service names between two instants (at most 42 days). Staff see only their own calendar; the owner can see any or all.",
      inputSchema: mcpListScheduleInput.shape,
      outputSchema: mcpListScheduleOutput.shape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(ctx, "list_schedule", async (args: z.infer<typeof mcpListScheduleInput>) => {
      const query: CalendarQuery = {
        from: args.from,
        to: args.to,
        staffIds: args.staffId ? [args.staffId] : undefined,
      };
      if (Date.parse(query.to) <= Date.parse(query.from)) {
        throw new DomainError("validation_error", "`to` must be after `from`");
      }
      if (Date.parse(query.to) - Date.parse(query.from) > 42 * DAY_MS) {
        throw new DomainError("validation_error", "The window cannot exceed 42 days");
      }
      const scope = authorizeCalendarQuery(principal, query);
      const calendar = await getCalendar(db, query, scope);
      return {
        timezone: calendar.timezone,
        staff: calendar.staff,
        appointments: calendar.appointments.map((a) => redactNotes(principal, a)),
      };
    }),
  );

  server.registerTool(
    "find_client",
    {
      title: "Find a client",
      description:
        "Staff and owners only. Searches clients by part of their name, phone number or email and returns their ids (needed by create_appointment). Returns contact details: use them only for the booking at hand.",
      inputSchema: mcpFindClientInput.shape,
      outputSchema: mcpFindClientOutput.shape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(ctx, "find_client", async (args: z.infer<typeof mcpFindClientInput>) => {
      authorizeClientAccess(principal);
      const result = await listClients(db, {
        page: 1,
        pageSize: args.pageSize ?? MCP_PAGE_SIZE_DEFAULT,
        search: args.search,
        sort: "name",
        order: "asc",
      });
      return {
        total: result.total,
        clients: result.clients.map(
          ({ notes: _n, createdAt: _c, updatedAt: _u, ...client }) => client,
        ),
      };
    }),
  );
}

/**
 * A retried booking: the appointment `requestId` already created, but only when it matches what
 * this caller is asking for right now (same professional, start and client). The request has
 * already passed the create policy, so returning it reveals nothing the caller could not
 * create; a requestId that collides with someone else's appointment is not a replay.
 */
async function findOwnedReplay(ctx: ToolContext, id: string, request: CreateAppointmentRequest) {
  const [row] = await ctx.db
    .select()
    .from(appointment)
    .where(and(eq(appointment.id, id), isNull(appointment.deletedAt)));
  if (!row) return null;
  const same =
    row.staffId === request.staffId &&
    row.startsAt.getTime() === Date.parse(request.startsAt) &&
    row.clientId === request.clientId;
  if (!same) return null;
  const snapshots = (await loadSnapshots(ctx.db, [id])).get(id) ?? [];
  return toAppointment(row, snapshots);
}
