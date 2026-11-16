import { z } from "zod";
import { appointmentSchema, createAppointmentBaseSchema } from "./appointments";
import { bookingPolicySchema } from "./booking-protection";
import { idSchema, instantSchema } from "./common";

export const appointmentSeriesInputSchema = createAppointmentBaseSchema
  .omit({ id: true })
  .extend({
    cadence: z.enum(["weekly", "monthly"]),
    interval: z.number().int().min(1).max(12),
    count: z.number().int().min(2).max(12),
  })
  .strict()
  .refine((v) => !(v.clientId && v.client), {
    message: "Provide only one client identity",
    path: ["clientId"],
  });
export type AppointmentSeriesInput = z.infer<typeof appointmentSeriesInputSchema>;
export const appointmentSeriesCreateSchema = appointmentSeriesInputSchema.safeExtend({
  reviewHash: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: z.string().min(8).max(120),
});
export type AppointmentSeriesCreate = z.infer<typeof appointmentSeriesCreateSchema>;
export const appointmentSeriesPreviewSchema = z.object({
  reviewHash: z.string(),
  timezone: z.string(),
  perVisitCents: z.number().int().nonnegative(),
  currency: z.string(),
  policy: bookingPolicySchema,
  occurrences: z.array(
    z.object({ startsAt: instantSchema, endsAt: instantSchema, available: z.boolean() }),
  ),
});
export type AppointmentSeriesPreview = z.infer<typeof appointmentSeriesPreviewSchema>;
export const appointmentSeriesSchema = z.object({
  id: idSchema,
  timezone: z.string(),
  cadence: z.enum(["weekly", "monthly"]),
  interval: z.number().int().positive(),
  appointments: z.array(appointmentSchema),
});
export type AppointmentSeries = z.infer<typeof appointmentSeriesSchema>;
