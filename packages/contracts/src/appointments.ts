import { z } from "zod";
import { bookingPriceSchema, bookingPromotionReviewSchema } from "./booking-promotions";
import { bookingProtectionSchema } from "./booking-protection";
import {
  idSchema,
  instantSchema,
  LIMITS,
  pageInfoSchema,
  pageSchema,
  pageSizeSchema,
} from "./common";
import { intakeBookingShape } from "./intake";
import { processingTimeSchema, workWindowSchema } from "./staff-capacity";

export const appointmentStatusSchema = z.enum(["booked", "completed", "cancelled", "no_show"]);
export type AppointmentStatus = z.infer<typeof appointmentStatusSchema>;

export const appointmentServiceSchema = z
  .object({
    serviceId: idSchema.nullable(),
    name: z.string(),
    durationMinutes: z.number().int().nonnegative(),
    bufferMinutes: z.number().int().min(0),
    processing: processingTimeSchema.optional(),
    priceCents: z.number().int().min(0),
    currency: z.string().length(3),
  })
  .refine(
    (s) =>
      !s.processing || s.processing.startsAfterMinutes + s.processing.minutes < s.durationMinutes,
    { message: "Processing requires final hands-on work", path: ["processing"] },
  );

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
  workWindows: z.array(workWindowSchema).max(48).optional(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
  protection: bookingProtectionSchema.nullable().optional(),
  bookingPrice: bookingPriceSchema.optional(),
  series: z
    .object({
      id: idSchema,
      position: z.number().int().nonnegative(),
      count: z.number().int().positive(),
    })
    .optional(),
});

export type Appointment = z.infer<typeof appointmentSchema>;

export const inlineClientSchema = z.object({
  name: z.string().min(1).max(LIMITS.name),
  phone: z.string().min(3).max(LIMITS.phone).optional(),
  email: z.email().max(LIMITS.email).optional(),
});

/**
 * Booking fields without the client identity. Clients book for themselves, so the server pins
 * their profile and the payload carries neither `clientId` nor `client`.
 */
export const createAppointmentBaseSchema = z.object({
  ...intakeBookingShape,
  /** Optional client-generated UUID (v7) so offline clients can pre-assign ids. */
  id: idSchema.optional(),
  staffId: idSchema,
  serviceIds: z.array(idSchema).min(1).max(24),
  /** Optional compatibility fence: reject changed reviewed catalog terms before creating a visit. */
  serviceQuotes: z
    .record(idSchema, z.string().regex(/^[a-f0-9]{64}$/))
    .refine((quotes) => Object.keys(quotes).length >= 1 && Object.keys(quotes).length <= 24, {
      message: "Review quotes for 1 to 24 services",
    })
    .optional(),
  startsAt: instantSchema,
  clientId: idSchema.optional(),
  client: inlineClientSchema.optional(),
  notes: z.string().max(LIMITS.notes).optional(),
  /**
   * Staff and owners only: book inside the minimum-notice window. It never bypasses working
   * hours, time off or the maximum advance window, and the use is audited.
   */
  override: z.boolean().optional(),
  protectionAcceptedVersion: z.number().int().positive().optional(),
  protectionAcceptedTotalCents: z.number().int().min(0).max(999999999).optional(),
  protectionWaiverReason: z.string().trim().min(8).max(300).optional(),
  promotion: bookingPromotionReviewSchema.optional(),
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

/** Statuses a caller may move an appointment to; "booked" is only ever the starting point. */
export const appointmentTransitionSchema = z.enum(["completed", "no_show", "cancelled"]);
export type AppointmentTransition = z.infer<typeof appointmentTransitionSchema>;

/**
 * One request does one thing: change the status (see ADR 0004 for who may and when), or move
 * the appointment (`startsAt` / `staffId`), optionally with notes. `override` skips only the
 * minimum-notice rule of a move and is for staff and owners.
 */
export const updateAppointmentRequestSchema = z
  .object({
    /** The version the caller last saw; the update fails with 409 if it is stale. */
    version: z.number().int().positive(),
    status: appointmentTransitionSchema.optional(),
    startsAt: instantSchema.optional(),
    staffId: idSchema.optional(),
    notes: z.string().max(LIMITS.notes).optional(),
    override: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.status !== undefined ||
      value.startsAt !== undefined ||
      value.staffId !== undefined ||
      value.notes !== undefined,
    { message: "Provide at least one change", path: ["status"] },
  )
  .refine(
    (value) =>
      value.status === undefined || (value.startsAt === undefined && value.staffId === undefined),
    { message: "A status change cannot be combined with rescheduling", path: ["status"] },
  );

export type UpdateAppointmentRequest = z.infer<typeof updateAppointmentRequestSchema>;

export const APPOINTMENT_PAGE_SIZE_DEFAULT = 50;
export const APPOINTMENT_PAGE_SIZE_MAX = 200;

/** Comma-separated statuses from a query string, for example `booked,completed`. */
const statusFilterSchema = z
  .string()
  .transform((value) => value.split(",").filter((part) => part.length > 0))
  .pipe(
    z
      .array(appointmentStatusSchema)
      .min(1)
      .refine((statuses) => new Set(statuses).size === statuses.length, {
        message: "status values must be unique",
      }),
  );

/**
 * Paging and the status filter are optional: without them the endpoint behaves as before, with
 * the default page size applied by the service (see `APPOINTMENT_PAGE_SIZE_DEFAULT`).
 */
export const appointmentListQuerySchema = z
  .object({
    from: instantSchema,
    to: instantSchema,
    staffId: idSchema.optional(),
    status: statusFilterSchema.optional(),
    page: pageSchema.optional(),
    pageSize: pageSizeSchema(APPOINTMENT_PAGE_SIZE_MAX).optional(),
  })
  .refine((value) => Date.parse(value.to) > Date.parse(value.from), {
    message: "`to` must be after `from`",
    path: ["to"],
  });

export type AppointmentListQuery = z.infer<typeof appointmentListQuerySchema>;

export const listAppointmentsResponseSchema = pageInfoSchema.extend({
  appointments: z.array(appointmentSchema),
});
export type ListAppointmentsResponse = z.infer<typeof listAppointmentsResponseSchema>;
