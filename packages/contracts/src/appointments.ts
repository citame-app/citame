import { z } from "zod";
import { idSchema, instantSchema } from "./common";

export const appointmentStatusSchema = z.enum(["booked", "completed", "cancelled", "no_show"]);
export type AppointmentStatus = z.infer<typeof appointmentStatusSchema>;

export const appointmentServiceSchema = z.object({
  serviceId: idSchema.nullable(),
  name: z.string(),
  durationMinutes: z.number().int().positive(),
  bufferMinutes: z.number().int().min(0),
  priceCents: z.number().int().min(0),
  currency: z.string().length(3),
});

export const appointmentSchema = z.object({
  id: idSchema,
  staffId: idSchema,
  clientId: idSchema,
  startsAt: instantSchema,
  endsAt: instantSchema,
  status: appointmentStatusSchema,
  notes: z.string().nullable(),
  version: z.number().int().positive(),
  services: z.array(appointmentServiceSchema),
  createdAt: instantSchema,
  updatedAt: instantSchema,
});

export type Appointment = z.infer<typeof appointmentSchema>;

export const inlineClientSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(3).optional(),
  email: z.email().optional(),
});

/**
 * Booking fields without the client identity. Clients book for themselves, so the server pins
 * their profile and the payload carries neither `clientId` nor `client`.
 */
export const createAppointmentBaseSchema = z.object({
  /** Optional client-generated UUID (v7) so offline clients can pre-assign ids. */
  id: idSchema.optional(),
  staffId: idSchema,
  serviceIds: z.array(idSchema).min(1),
  startsAt: instantSchema,
  clientId: idSchema.optional(),
  client: inlineClientSchema.optional(),
  notes: z.string().optional(),
  /**
   * Staff and owners only: book inside the minimum-notice window. It never bypasses working
   * hours, time off or the maximum advance window, and the use is audited.
   */
  override: z.boolean().optional(),
});

/** Staff and owners must say who the appointment is for: exactly one of `clientId` / `client`. */
export const createAppointmentRequestSchema = createAppointmentBaseSchema.refine(
  (value) => (value.clientId === undefined) !== (value.client === undefined),
  {
    message: "Provide exactly one of clientId or client",
    path: ["clientId"],
  },
);

export type CreateAppointmentRequest = z.infer<typeof createAppointmentRequestSchema>;

export const updateAppointmentRequestSchema = z
  .object({
    /** The version the caller last saw; the update fails with 409 if it is stale. */
    version: z.number().int().positive(),
    status: z.literal("cancelled").optional(),
    startsAt: instantSchema.optional(),
    staffId: idSchema.optional(),
    notes: z.string().optional(),
  })
  .refine(
    (value) =>
      value.status !== undefined ||
      value.startsAt !== undefined ||
      value.staffId !== undefined ||
      value.notes !== undefined,
    { message: "Provide at least one change", path: ["status"] },
  );

export type UpdateAppointmentRequest = z.infer<typeof updateAppointmentRequestSchema>;

export const appointmentListQuerySchema = z
  .object({
    from: instantSchema,
    to: instantSchema,
    staffId: idSchema.optional(),
  })
  .refine((value) => Date.parse(value.to) > Date.parse(value.from), {
    message: "`to` must be after `from`",
    path: ["to"],
  });

export type AppointmentListQuery = z.infer<typeof appointmentListQuerySchema>;

export const listAppointmentsResponseSchema = z.object({
  appointments: z.array(appointmentSchema),
});
export type ListAppointmentsResponse = z.infer<typeof listAppointmentsResponseSchema>;
