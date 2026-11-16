import { z } from "zod";
import { appointmentSchema } from "./appointments";
import { bookingPolicySchema } from "./booking-protection";
import {
  idSchema,
  instantSchema,
  localDateSchema,
  pageInfoSchema,
  pageSchema,
  pageSizeSchema,
} from "./common";
import { intakeBookingShape } from "./intake";
import { processingTimeSchema } from "./staff-capacity";

const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const waitlistPolicySchema = z.object({
  enabled: z.boolean(),
  offerMinutes: z.number().int().min(5).max(120),
  version: z.number().int().positive(),
});
export type WaitlistPolicy = z.infer<typeof waitlistPolicySchema>;
export const waitlistInputSchema = z
  .object({
    serviceIds: z
      .array(idSchema)
      .min(1)
      .max(8)
      .refine((ids) => new Set(ids).size === ids.length, { message: "Services must be unique" }),
    staffId: idSchema.nullable().optional(),
    fromDate: localDateSchema,
    toDate: localDateSchema,
    fromTime: time,
    toTime: time,
    idempotencyKey: z.string().min(8).max(120),
  })
  .strict()
  .refine((v) => v.fromTime < v.toTime, {
    path: ["toTime"],
    message: "The end time must be after the start time",
  })
  .refine(
    (v) => v.toDate >= v.fromDate && Date.parse(v.toDate) - Date.parse(v.fromDate) <= 29 * 86400000,
    { path: ["toDate"], message: "Choose at most 30 calendar dates in order" },
  );
export type WaitlistInput = z.infer<typeof waitlistInputSchema>;
export const waitlistAdminInputSchema = waitlistInputSchema.safeExtend({ clientId: idSchema });
export const waitlistStateSchema = z.enum([
  "waiting",
  "offered",
  "booked",
  "cancelled",
  "expired",
  "unavailable",
]);
export const waitlistOfferSchema = z.object({
  id: idSchema,
  staffId: idSchema,
  staffName: z.string().optional(),
  startsAt: instantSchema,
  endsAt: instantSchema,
  expiresAt: instantSchema,
  priceCents: z.number().int().nonnegative(),
  currency: z.string().length(3),
  services: z.array(
    z.object({
      id: idSchema,
      name: z.string(),
      durationMinutes: z.number().int().nonnegative(),
      processing: processingTimeSchema.optional(),
      bufferMinutes: z.number().int().nonnegative(),
      priceCents: z.number().int().nonnegative(),
      currency: z.string(),
    }),
  ),
  policy: bookingPolicySchema,
});
export type WaitlistOffer = z.infer<typeof waitlistOfferSchema>;
export const waitlistEntrySchema = z.object({
  id: idSchema,
  clientId: idSchema,
  clientName: z.string().optional(),
  serviceIds: z.array(idSchema),
  staffId: idSchema.nullable(),
  serviceNames: z.array(z.string()),
  fromDate: localDateSchema,
  toDate: localDateSchema,
  fromTime: time,
  toTime: time,
  timezone: z.string(),
  state: waitlistStateSchema,
  version: z.number().int().positive(),
  createdAt: instantSchema,
  offer: waitlistOfferSchema.nullable(),
  appointmentId: idSchema.nullable(),
  bookedAppointment: appointmentSchema
    .pick({ id: true, staffId: true, startsAt: true, status: true })
    .nullable()
    .default(null),
  canManage: z.boolean().default(false),
});
export type WaitlistEntry = z.infer<typeof waitlistEntrySchema>;
export const waitlistListSchema = pageInfoSchema.extend({
  entries: z.array(waitlistEntrySchema),
  policy: waitlistPolicySchema,
});
export const waitlistQuerySchema = z.object({
  page: pageSchema.max(100000).optional(),
  pageSize: pageSizeSchema(50).optional(),
  state: waitlistStateSchema.optional(),
});
export type WaitlistQuery = z.infer<typeof waitlistQuerySchema>;
export const waitlistCancelSchema = z.object({ version: z.number().int().positive() }).strict();
export const waitlistDeclineSchema = waitlistCancelSchema
  .extend({ offerId: idSchema, requeue: z.boolean() })
  .strict();
export const waitlistAcceptSchema = z
  .object({
    ...intakeBookingShape,
    version: z.number().int().positive(),
    offerId: idSchema,
    idempotencyKey: z.string().min(8).max(120),
    expectedTotalCents: z.number().int().nonnegative().max(999999999),
    protectionAcceptedVersion: z.number().int().positive().optional(),
    protectionAcceptedTotalCents: z.number().int().nonnegative().max(999999999).optional(),
    protectionWaiverReason: z.string().trim().min(8).max(300).optional(),
  })
  .strict();
export type WaitlistAccept = z.infer<typeof waitlistAcceptSchema>;
export const waitlistAcceptedSchema = z.object({
  entry: waitlistEntrySchema,
  appointment: appointmentSchema,
});
