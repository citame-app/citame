import { z } from "zod";
import { calendarServiceBadgesSchema } from "./appointment-context";
import { appointmentSchema } from "./appointments";
import { externalBalanceSchema, moneyCentsSchema } from "./commerce";
import { idSchema, instantSchema } from "./common";
import { resourceKindSchema } from "./resources";
import { timeOffSchema } from "./staff";

/** Longest window one calendar request may cover (six weeks). */
export const CALENDAR_MAX_DAYS = 42;

export const calendarViewSchema = z.enum(["day", "week", "month", "list", "resources"]);
export type CalendarView = z.infer<typeof calendarViewSchema>;

export const desktopCalendarTargetSchema = z.object({
  date: z.iso.date(),
  view: calendarViewSchema,
  staff: z
    .string()
    .min(36)
    .max(3699)
    .refine((input) => {
      const ids = input.split(",");
      return ids.length <= 100 && ids.every((id) => idSchema.safeParse(id).success);
    })
    .optional(),
});

const MS_PER_DAY = 86_400_000;

/**
 * `GET /appointments/calendar`. `staffIds` is a comma-separated list; leave it out for every
 * active staff member the caller may see.
 */
export const booksyBillingCapabilitiesSchema = z.object({
  booksyPaymentReview: z.literal("1").optional(),
  booksyBalanceReview: z.literal("1").optional(),
});
export type BooksyBillingCapabilities = z.infer<typeof booksyBillingCapabilitiesSchema>;

export const calendarQuerySchema = z
  .object({
    from: instantSchema,
    to: instantSchema,
    ...booksyBillingCapabilitiesSchema.shape,
    resourceOccupancy: z.literal("1").optional(),
    staffIds: z
      .string()
      .transform((value) => value.split(",").filter((part) => part.length > 0))
      .pipe(
        z
          .array(idSchema)
          .min(1)
          .refine((ids) => new Set(ids).size === ids.length, {
            message: "staffIds must be unique",
          }),
      )
      .optional(),
  })
  .refine((value) => Date.parse(value.to) > Date.parse(value.from), {
    message: "`to` must be after `from`",
    path: ["to"],
  })
  .refine(
    // Six local weeks can contain the extra hour when daylight saving time ends.
    (value) =>
      Date.parse(value.to) - Date.parse(value.from) <= CALENDAR_MAX_DAYS * MS_PER_DAY + 3_600_000,
    {
      message: `The range cannot exceed ${CALENDAR_MAX_DAYS} days`,
      path: ["to"],
    },
  )
  .refine(
    (value) =>
      !value.resourceOccupancy || Date.parse(value.to) - Date.parse(value.from) <= 25 * 3_600_000,
    { message: "Resource occupancy covers one day", path: ["to"] },
  );
export type CalendarQuery = z.infer<typeof calendarQuerySchema>;

const billingReviewReasonSchema = z.enum([
  "unknown_amount",
  "paid_in_booksy",
  "invoiced_in_booksy",
  "unknown_booksy_payment",
  "booksy_balance_changed",
]);
export type BillingReviewReason = z.infer<typeof billingReviewReasonSchema>;
export const billingReviewReasonsSchema = z.array(billingReviewReasonSchema).min(1).max(3);

export const calendarAppointmentSchema = appointmentSchema.extend({
  clientName: z.string(),
  hasVisitCheckout: z.literal(true).optional(),
  serviceBadges: z.array(calendarServiceBadgesSchema).optional(),
  serviceColors: z.record(idSchema, z.string().regex(/^#[0-9a-fA-F]{6}$/)).optional(),
  resources: z
    .array(
      z.object({
        resourceId: idSchema.optional(),
        name: z.string(),
        quantity: z.number().int().positive(),
      }),
    )
    .optional(),
  /** In booking order. */
  serviceNames: z.array(z.string()),
  billingReviewReasons: billingReviewReasonsSchema.optional(),
  externallySettled: z.literal(true).optional(),
  importedFromBooksy: z.literal(true).optional(),
  booksyUnpaidConfirmed: z.literal(true).optional(),
  externalBalance: externalBalanceSchema.optional(),
  unpricedServices: z
    .array(z.object({ id: idSchema, name: z.string() }))
    .min(1)
    .optional(),
});
export const unpaidReceiptBalanceSchema = z.object({
  id: idSchema,
  confirmedCents: moneyCentsSchema,
  balanceCents: moneyCentsSchema.positive().nullable(),
  pricePending: z.boolean(),
  paymentInProgress: z.boolean(),
  serviceBalanceDeferred: z.literal(true).optional(),
});
export const unpaidAppointmentsSchema = z.object({
  appointments: z.array(
    calendarAppointmentSchema.extend({
      receiptBalance: unpaidReceiptBalanceSchema.optional(),
      receiptRestricted: z.literal(true).optional(),
    }),
  ),
  billingReview: z
    .array(
      calendarAppointmentSchema
        .pick({
          id: true,
          clientName: true,
          staffId: true,
          startsAt: true,
          serviceNames: true,
        })
        .extend({ reasons: billingReviewReasonsSchema }),
    )
    .optional(),
});
export type UnpaidAppointments = z.infer<typeof unpaidAppointmentsSchema>;

export type CalendarAppointment = z.infer<typeof calendarAppointmentSchema>;

/** One block of a staff member's recurring hours, resolved to instants in the salon timezone. */
export const workingWindowSchema = z.object({
  staffId: idSchema,
  startsAt: instantSchema,
  endsAt: instantSchema,
});
export type WorkingWindow = z.infer<typeof workingWindowSchema>;

const resourceOccupancyWindowSchema = z.object({
  startsAt: instantSchema,
  endsAt: instantSchema,
  quantity: z.number().int().positive(),
  /** Present only for a booking included in the calendar response. */
  appointmentId: idSchema.optional(),
  /** Temporary waitlist capacity. The offer and its client are never included. */
  holdExpiresAt: instantSchema.optional(),
});
export const resourceOccupancySchema = z.object({
  capturedAt: instantSchema,
  pools: z.array(
    z.object({
      id: idSchema,
      name: z.string(),
      kind: resourceKindSchema,
      capacity: z.number().int().min(1).max(20),
      active: z.boolean(),
      windows: z.array(resourceOccupancyWindowSchema),
    }),
  ),
});
export type ResourceOccupancy = z.infer<typeof resourceOccupancySchema>;

/** Everything a day/week calendar needs in one response. */
export const calendarResponseSchema = z.object({
  importSnapshot: z
    .object({
      system: z.literal("booksy"),
      capturedAt: instantSchema,
      fromDate: z.iso.date(),
      throughDate: z.iso.date(),
      readOnly: z.literal(true),
    })
    .optional(),
  timezone: z.string(),
  from: instantSchema,
  to: instantSchema,
  /** The calendar columns, in display order. */
  staff: z.array(z.object({ id: idSchema, displayName: z.string() })),
  /** Appointments overlapping the range, cancelled ones included (check `status`). */
  appointments: z.array(calendarAppointmentSchema),
  timeOff: z.array(timeOffSchema),
  workingWindows: z.array(workingWindowSchema),
  resourceOccupancy: resourceOccupancySchema.optional(),
});
export type CalendarResponse = z.infer<typeof calendarResponseSchema>;
