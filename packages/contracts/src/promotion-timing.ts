import { z } from "zod";

/** Salon-local appointment start; an overnight offer needs two explicit windows. */
export const promotionTimingSchema = z
  .object({
    weekdays: z
      .array(z.number().int().min(1).max(7))
      .min(1)
      .max(7)
      .refine((days) => new Set(days).size === days.length),
    startMinute: z.number().int().min(0).max(1439),
    endMinute: z.number().int().min(1).max(1440),
    lastMinuteHours: z.number().int().min(1).max(168).nullable(),
  })
  .strict()
  .refine((value) => value.startMinute < value.endMinute, {
    path: ["endMinute"],
    message: "End must follow the start on the same day",
  });
export type PromotionTiming = z.infer<typeof promotionTimingSchema>;
export const appointmentPromotionTimingSchema = z.object({
  timing: promotionTimingSchema,
  timeZone: z.string().min(1).max(100),
});
