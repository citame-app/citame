import { z } from "zod";
import { idSchema, instantSchema } from "./common";

export const bookingPolicyTermsSchema = z.object({
  enabled: z.boolean(),
  depositKind: z.enum(["percent", "fixed"]),
  depositValue: z.number().int().min(1).max(999999999),
  holdMinutes: z.number().int().min(5).max(60),
  cancellationWindowMinutes: z.number().int().min(0).max(43200),
  lateCancellationBasisPoints: z.number().int().min(0).max(10000),
  noShowBasisPoints: z.number().int().min(0).max(10000),
  trustedExempt: z.boolean(),
});
export const bookingPolicySchema = bookingPolicyTermsSchema.extend({
  version: z.number().int().positive(),
});
export const bookingPolicyInputSchema = bookingPolicySchema
  .strict()
  .refine((p) => p.depositKind !== "percent" || p.depositValue <= 10000, {
    path: ["depositValue"],
    message: "Percentage cannot exceed 100%",
  });
export const bookingProtectionSchema = z.object({
  checkoutId: idSchema,
  state: z.enum(["pending", "confirmed", "waived", "completed", "cancelled", "expired", "no_show"]),
  depositCents: z.number().int().nonnegative(),
  policyVersion: z.number().int().positive(),
  expiresAt: instantSchema,
  cancellationCutoff: instantSchema,
  lateCancellationBasisPoints: z.number().int().nonnegative(),
  noShowBasisPoints: z.number().int().nonnegative(),
  feeCents: z.number().int().nonnegative(),
  refundDueCents: z.number().int().nonnegative(),
});
export type BookingPolicy = z.infer<typeof bookingPolicySchema>;
export type BookingProtection = z.infer<typeof bookingProtectionSchema>;
