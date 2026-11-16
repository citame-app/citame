import { z } from "zod";
import { appointmentSchema, appointmentStatusSchema } from "./appointments";
import { bookingPolicySchema } from "./booking-protection";
import { adminClientSchema } from "./clients";
import { idSchema, instantSchema, localDateSchema } from "./common";
import { serviceSchema } from "./services";
import { staffSchema } from "./staff";

/**
 * Inputs and outputs of the MCP tools (ADR 0009). They are composed from the same field schemas
 * as the REST contracts, so a rule changed once (an id format, a date format) changes everywhere.
 * Inputs describe themselves because an LLM reads these descriptions to decide what to send.
 */

const MCP_PAGE_SIZE_MAX = 50;
const MCP_PAGE_SIZE_DEFAULT = 20;

export { MCP_PAGE_SIZE_DEFAULT, MCP_PAGE_SIZE_MAX };

export const mcpListServicesInput = z.object({});
export const mcpListServicesOutput = z.object({
  bookingPolicy: bookingPolicySchema.optional(),
  services: z.array(serviceSchema),
  staff: z.array(staffSchema).describe("Professionals who can be booked. Use their id as staffId."),
});

export const mcpFindAvailabilityInput = z.object({
  serviceIds: z
    .array(idSchema)
    .min(1)
    .max(10)
    .describe("Ids of the services to book together, from list_services."),
  staffId: idSchema.optional().describe("Only look at this professional. Omit to search everyone."),
  date: localDateSchema.describe("Calendar day in the salon's timezone, YYYY-MM-DD."),
});
export const mcpFindAvailabilityOutput = z.object({
  date: localDateSchema,
  timezone: z.string().describe("IANA timezone the salon works in."),
  slots: z.array(
    z.object({
      staffId: idSchema,
      startsAt: instantSchema,
      endsAt: instantSchema,
    }),
  ),
});

export const mcpCreateAppointmentInput = z.object({
  staffId: idSchema.describe("Professional to book, from find_availability."),
  serviceIds: z.array(idSchema).min(1).max(10).describe("Ids of the services, from list_services."),
  startsAt: instantSchema.describe(
    "Start instant, copied exactly from a slot returned by find_availability.",
  ),
  clientId: idSchema
    .optional()
    .describe(
      "Staff and owners only: the client being booked, from find_client. Clients book for themselves and must omit this.",
    ),
  notes: z.string().trim().max(500).optional().describe("Optional note for the salon."),
  protectionAcceptedVersion: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Only after the customer explicitly accepts the current deposit and cancellation policy from list_services.",
    ),
  protectionAcceptedTotalCents: z
    .number()
    .int()
    .min(0)
    .max(999999999)
    .optional()
    .describe(
      "Service total shown to and accepted by the customer, before any membership discount. Never infer acceptance.",
    ),
  protectionWaiverReason: z
    .string()
    .trim()
    .min(8)
    .max(300)
    .optional()
    .describe("Managers only: explicit reason to waive a deposit for a salon booking."),
  requestId: idSchema
    .optional()
    .describe(
      "A UUID you generate once per booking intent. If a call times out, repeat it with the same requestId: you get the same appointment back instead of a duplicate.",
    ),
});
export const mcpCreateAppointmentOutput = z.object({
  appointment: appointmentSchema,
  replayed: z.boolean().describe("True when this requestId had already created the appointment."),
});

export const mcpCancelAppointmentInput = z.object({
  appointmentId: idSchema.describe("Id of the appointment, from list_my_appointments."),
});
export const mcpCancelAppointmentOutput = z.object({ appointment: appointmentSchema });

export const mcpListMyAppointmentsInput = z.object({
  from: instantSchema.optional().describe("Start of the window. Defaults to now."),
  to: instantSchema.optional().describe("End of the window. Defaults to 90 days after `from`."),
  status: z
    .array(appointmentStatusSchema)
    .min(1)
    .optional()
    .describe("Only these statuses. Defaults to every status."),
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).max(MCP_PAGE_SIZE_MAX).optional(),
});
export const mcpListMyAppointmentsOutput = z.object({
  appointments: z.array(appointmentSchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});

export const mcpListScheduleInput = z.object({
  from: instantSchema.describe("Start of the window."),
  to: instantSchema.describe("End of the window. At most 42 days after `from`."),
  staffId: idSchema
    .optional()
    .describe("Only this calendar. Staff can only read their own; omit for everyone you may see."),
});
export const mcpScheduleAppointmentSchema = appointmentSchema.extend({
  clientName: z.string(),
  serviceNames: z.array(z.string()),
});
export const mcpListScheduleOutput = z.object({
  timezone: z.string(),
  staff: z.array(z.object({ id: idSchema, displayName: z.string() })),
  appointments: z.array(mcpScheduleAppointmentSchema),
});

export const mcpFindClientInput = z.object({
  search: z
    .string()
    .trim()
    .min(2)
    .max(100)
    .describe("Part of the client's name, phone number or email."),
  pageSize: z.number().int().min(1).max(MCP_PAGE_SIZE_MAX).optional(),
});
export const mcpClientSchema = adminClientSchema.omit({
  notes: true,
  createdAt: true,
  updatedAt: true,
});
export const mcpFindClientOutput = z.object({
  clients: z.array(mcpClientSchema),
  total: z.number().int(),
});

/** Which MCP tool needs which OAuth scope. Mirrored in docs/mcp.md. */
export const MCP_TOOL_SCOPES = {
  list_services: "mcp:read",
  find_availability: "mcp:read",
  list_my_appointments: "mcp:read",
  create_appointment: "mcp:book",
  cancel_appointment: "mcp:book",
  list_schedule: "schedule:read",
  find_client: "schedule:read",
} as const;
export type McpToolName = keyof typeof MCP_TOOL_SCOPES;
