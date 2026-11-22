import { z } from "zod";
import { idSchema, instantSchema, syncGenerationSchema } from "./common";

export const MAX_PEAK_PRICE_RULES = 100;
export const MAX_PEAK_PRICE_SERVICES = 200;
export const MAX_PEAK_PRICE_BASIS_POINTS = 10_000;

export const peakPriceReviewSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const peakPriceRuleSchema = z
  .object({
    weekday: z.number().int().min(1).max(7),
    startMinute: z.number().int().min(0).max(1439),
    endMinute: z.number().int().min(1).max(1440),
    increaseBasisPoints: z.number().int().min(1).max(MAX_PEAK_PRICE_BASIS_POINTS),
    serviceIds: z.array(idSchema).max(MAX_PEAK_PRICE_SERVICES).default([]),
  })
  .strict()
  .refine((rule) => rule.startMinute < rule.endMinute, {
    path: ["endMinute"],
    message: "The end must be later on the same day",
  });
export const peakPricePolicySchema = z
  .object({
    version: z.number().int().nonnegative().max(2_147_483_647),
    generation: syncGenerationSchema,
    rules: z.array(peakPriceRuleSchema).max(MAX_PEAK_PRICE_RULES),
  })
  .strict();

export const peakPriceQuerySchema = z.object({
  serviceIds: z
    .string()
    .transform((value) => value.split(","))
    .pipe(z.array(idSchema).min(1).max(24)),
  startsAt: instantSchema,
});

export const peakPriceQuoteSchema = z.object({
  startsAt: instantSchema,
  review: peakPriceReviewSchema.nullable(),
  services: z.array(
    z.object({
      serviceId: idSchema,
      currency: z.string().length(3),
      baseCents: z.number().int().nonnegative(),
      surchargeCents: z.number().int().nonnegative(),
      priceCents: z.number().int().nonnegative(),
    }),
  ),
});

export type PeakPriceRule = z.infer<typeof peakPriceRuleSchema>;
export type PeakPricePolicy = z.infer<typeof peakPricePolicySchema>;
export type PeakPriceQuote = z.infer<typeof peakPriceQuoteSchema>;
