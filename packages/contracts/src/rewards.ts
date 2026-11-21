import { z } from "zod";
import { idSchema, instantSchema, pageInfoSchema, syncGenerationSchema } from "./common";
import { appointmentPromotionTimingSchema, promotionTimingSchema } from "./promotion-timing";

const points = z.number().int().min(0).max(1000000000);
const money = z.number().int().min(0).max(999999999);
export const loyaltyPolicySchema = z.object({
  enabled: z.boolean(),
  earnEveryCents: money.min(100),
  pointsPerStep: points.min(1).max(100),
  redeemValueCents: money.min(1).max(10000),
  maximumDiscountBasisPoints: z.number().int().min(1).max(10000),
  expiryDays: z.number().int().min(30).max(3650).nullable(),
  version: z.number().int().positive(),
});
export const loyaltyPolicyInputSchema = loyaltyPolicySchema.strict();
export const reviewedLoyaltyPolicySchema = loyaltyPolicySchema.extend({
  generation: syncGenerationSchema,
});
export const rewardAdjustmentInputSchema = z
  .object({
    points: z
      .number()
      .int()
      .min(-1000000)
      .max(1000000)
      .refine((v) => v !== 0),
    reason: z.string().trim().min(8).max(300),
    idempotencyKey: z.string().min(8).max(120),
  })
  .strict();
export const rewardChoiceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("points"), points: points.positive() }).strict(),
  z
    .object({
      kind: z.literal("promotion"),
      code: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z0-9][A-Z0-9_-]{2,39}$/),
    })
    .strict(),
]);
export const applyRewardInputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("points"),
      points: points.positive(),
      expectedTotalCents: money,
      expectedDiscountCents: money.positive(),
      idempotencyKey: z.string().min(8).max(120),
    })
    .strict(),
  z
    .object({
      kind: z.literal("promotion"),
      code: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z0-9][A-Z0-9_-]{2,39}$/),
      expectedTotalCents: money,
      expectedDiscountCents: money.positive(),
      expectedPromotionVersion: z.number().int().positive().optional(),
      idempotencyKey: z.string().min(8).max(120),
    })
    .strict(),
]);
export const checkoutRewardSchema = z.object({
  id: idSchema,
  kind: z.enum(["points", "promotion"]),
  name: z.string(),
  code: z.string().nullable(),
  pointsUsed: points,
  returnedPoints: points.default(0),
  discountCents: money,
  state: z.enum(["held", "applied", "released"]),
  expiresAt: instantSchema,
  appointmentTiming: appointmentPromotionTimingSchema.optional(),
});
export const rewardQuoteSchema = z.object({
  name: z.string(),
  kind: z.enum(["points", "promotion"]),
  pointsUsed: points,
  maximumPoints: points,
  discountCents: money,
  currentTotalCents: money,
  newTotalCents: money,
  promotionVersion: z.number().int().positive().optional(),
  appointmentTiming: appointmentPromotionTimingSchema.optional(),
});
export const loyaltyStatementSchema = z.object({
  policy: loyaltyPolicySchema,
  availablePoints: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  balancePoints: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  reservedPoints: z.number().int().nonnegative(),
  debtPoints: z.number().int().nonnegative(),
  expiringPoints: z.number().int().nonnegative(),
  movements: z.array(
    z.object({
      id: idSchema,
      kind: z.string(),
      points: z.number().int(),
      checkoutId: idSchema.nullable(),
      createdAt: instantSchema,
    }),
  ),
  pagination: pageInfoSchema,
});
export const loyaltyClientSearchSchema = z.object({
  search: z.string().trim().min(1).max(100),
});
export const loyaltyClientChoicesSchema = z.object({
  clients: z.array(z.object({ id: idSchema, name: z.string(), email: z.string().nullable() })),
});
export const adminLoyaltyStatementSchema = loyaltyStatementSchema.extend({
  generation: syncGenerationSchema,
  canAdjust: z.boolean(),
});
export const promotionInputSchema = z
  .object({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9][A-Z0-9_-]{2,39}$/),
    name: z.string().trim().min(1).max(100),
    kind: z.enum(["percent", "fixed"]),
    value: money.positive(),
    minimumSpendCents: money.default(0),
    maximumDiscountCents: money.positive().nullable().default(null),
    usageLimit: z.number().int().min(1).max(1000000).nullable().default(null),
    perClientLimit: z.number().int().min(1).max(1000000).nullable().default(1),
    startsAt: instantSchema.nullable().default(null),
    endsAt: instantSchema.nullable().default(null),
    eligibleKinds: z
      .array(z.enum(["service", "product", "custom"]))
      .min(1)
      .max(3)
      .refine((v) => new Set(v).size === v.length)
      .default(["service", "product", "custom"]),
    serviceIds: z.array(idSchema).max(100).default([]),
    active: z.boolean().default(true),
    timing: promotionTimingSchema.optional(),
    version: z.number().int().positive().nullable().default(null),
  })
  .strict()
  .refine((p) => p.kind !== "percent" || p.value <= 10000, {
    path: ["value"],
    message: "Percentage exceeds 100%",
  })
  .refine((p) => !p.timing || p.eligibleKinds.every((kind) => kind === "service"), {
    path: ["eligibleKinds"],
    message: "Timed promotions apply only to appointment services",
  })
  .refine((p) => !p.startsAt || !p.endsAt || Date.parse(p.startsAt) < Date.parse(p.endsAt), {
    path: ["endsAt"],
    message: "Expiry must follow the start",
  });
export const promotionSchema = promotionInputSchema.safeExtend({
  id: idSchema,
  version: z.number().int().positive(),
  createdAt: instantSchema,
  usedCount: z.number().int().nonnegative().default(0),
});
export type LoyaltyPolicy = z.infer<typeof loyaltyPolicySchema>;
export type RewardChoice = z.infer<typeof rewardChoiceSchema>;
export type ApplyRewardInput = z.infer<typeof applyRewardInputSchema>;
export type PromotionInput = z.infer<typeof promotionInputSchema>;
export type Promotion = z.infer<typeof promotionSchema>;
export type LoyaltyStatement = z.infer<typeof loyaltyStatementSchema>;
export type RewardQuote = z.infer<typeof rewardQuoteSchema>;
