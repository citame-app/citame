import { z } from "zod";
import { appointmentSchema, createAppointmentBaseSchema } from "./appointments";
import { bookingPolicySchema } from "./booking-protection";
import { idSchema, instantSchema, syncGenerationSchema } from "./common";
import { peakPriceReviewSchema } from "./peak-prices";

export const appointmentSeriesInputSchema = createAppointmentBaseSchema
  .omit({ id: true, promotion: true })
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
  peakPriceReviews: z.array(peakPriceReviewSchema.nullable()).min(2).max(12).optional(),
});
export type AppointmentSeriesCreate = z.infer<typeof appointmentSeriesCreateSchema>;
const desktopSeriesFields = {
  desktopGeneration: syncGenerationSchema,
  serviceQuotes: createAppointmentBaseSchema.shape.serviceQuotes.unwrap(),
  intakeReviewHash: createAppointmentBaseSchema.shape.intakeReviewHash.unwrap(),
};
export const desktopSeriesInputSchema =
  appointmentSeriesInputSchema.safeExtend(desktopSeriesFields);
export const desktopSeriesCreateSchema = appointmentSeriesCreateSchema
  .safeExtend({
    ...desktopSeriesFields,
    appointmentIds: z.array(idSchema).min(2).max(12),
  })
  .refine(
    ({ appointmentIds, count }) =>
      appointmentIds.length === count && new Set(appointmentIds).size === count,
    { path: ["appointmentIds"], message: "Provide one unique appointment ID for each date" },
  );
export const appointmentSeriesPreviewSchema = z.object({
  reviewHash: z.string(),
  timezone: z.string(),
  perVisitCents: z.number().int().nonnegative(),
  currency: z.string(),
  policy: bookingPolicySchema,
  occurrences: z.array(
    z.object({
      startsAt: instantSchema,
      endsAt: instantSchema,
      available: z.boolean(),
      priceCents: z.number().int().nonnegative().optional(),
      peakSurchargeCents: z.number().int().positive().optional(),
      peakPriceReview: peakPriceReviewSchema.optional(),
    }),
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
