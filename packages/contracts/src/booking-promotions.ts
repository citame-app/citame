import { z } from "zod";
import { idSchema, instantSchema } from "./common";
import { rewardQuoteSchema } from "./rewards";

const code = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9_-]{2,39}$/);
export const bookingPromotionReviewSchema = z
  .object({ code, reviewHash: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export const bookingPromotionQuoteRequestSchema = z
  .object({
    code,
    staffId: idSchema,
    serviceIds: z.array(idSchema).min(1).max(24),
    serviceQuotes: z
      .record(idSchema, z.string().regex(/^[a-f0-9]{64}$/))
      .refine((value) => Object.keys(value).length >= 1 && Object.keys(value).length <= 24),
    startsAt: instantSchema,
  })
  .strict();
export const bookingPromotionQuoteSchema = rewardQuoteSchema.extend({
  promotionVersion: z.number().int().positive(),
  reviewHash: z.string().regex(/^[a-f0-9]{64}$/),
  subtotalCents: z.number().int().nonnegative().max(999999999),
  currency: z.literal("EUR"),
});
export type BookingPromotionQuoteRequest = z.infer<typeof bookingPromotionQuoteRequestSchema>;
export type BookingPromotionQuote = z.infer<typeof bookingPromotionQuoteSchema>;
export const bookingPriceSchema = z
  .object({
    finalized: z.boolean().optional(),
    subtotalCents: z.number().int().min(0).max(999999999),
    discountCents: z.number().int().min(0).max(999999999),
    totalCents: z.number().int().min(0).max(999999999),
    currency: z.literal("EUR"),
  })
  .refine((value) => value.subtotalCents - value.discountCents === value.totalCents);
export type BookingPrice = z.infer<typeof bookingPriceSchema>;
