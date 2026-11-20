export const MEMBERSHIP_RECURRING_CONSENT_VERSION = "sob.membership-recurring.v1";

import { z } from "zod";
import { checkoutSchema, idempotencyKeySchema, moneyCentsSchema } from "./commerce";
import { idSchema, instantSchema, pageInfoSchema } from "./common";

const fields = {
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(1000).nullable(),
  kind: z.enum(["package", "membership"]),
  priceCents: moneyCentsSchema.positive(),
  taxBasisPoints: z.number().int().min(0).max(10000),
  includedUses: z.number().int().min(0).max(1000),
  discountBasisPoints: z.number().int().min(0).max(10000),
  serviceIds: z
    .array(idSchema)
    .min(1)
    .max(100)
    .refine((ids) => new Set(ids).size === ids.length, "Services must be unique"),
  validityDays: z.number().int().min(1).max(3650).nullable(),
  periodMonths: z.number().int().min(1).max(12).nullable(),
  active: z.boolean(),
};
const core = z.object(fields).strict();
function validatePlan(value: z.infer<typeof core>, ctx: z.RefinementCtx) {
  if (
    value.kind === "package" &&
    (value.includedUses < 1 || value.periodMonths !== null || value.discountBasisPoints !== 0)
  )
    ctx.addIssue({
      code: "custom",
      message: "Packages require visits and cannot have recurring periods or membership discounts",
    });
  if (
    value.kind === "membership" &&
    (value.periodMonths === null ||
      value.validityDays !== null ||
      (!value.includedUses && !value.discountBasisPoints))
  )
    ctx.addIssue({
      code: "custom",
      message: "Memberships require a billing interval and visits or a membership discount",
    });
  if (value.includedUses > value.priceCents)
    ctx.addIssue({
      code: "custom",
      message: "Each included visit must allocate at least one cent",
    });
}
export const benefitPlanTermsSchema = core.superRefine(validatePlan);
export const createBenefitPlanSchema = core
  .extend({
    description: fields.description.default(null),
    taxBasisPoints: fields.taxBasisPoints.default(0),
    discountBasisPoints: fields.discountBasisPoints.default(0),
    validityDays: fields.validityDays.default(null),
    periodMonths: fields.periodMonths.default(null),
    active: fields.active.default(true),
    idempotencyKey: idempotencyKeySchema,
  })
  .superRefine(validatePlan);
export const updateBenefitPlanSchema = core
  .omit({ kind: true })
  .partial()
  .extend({ version: z.number().int().positive() })
  .refine((value) => Object.keys(value).some((key) => key !== "version"), "Provide a plan change");
export const benefitPlanSchema = core.extend({
  id: idSchema,
  currency: z.literal("EUR"),
  version: z.number().int().positive(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
});
export const benefitPlanListSchema = z.object({ plans: z.array(benefitPlanSchema) });
export const benefitPurchaseSchema = z
  .object({
    planId: idSchema,
    planVersion: z.number().int().positive().optional(),
    clientId: idSchema.optional(),
    renewalMode: z.enum(["manual", "automatic"]).default("manual"),
    acceptRecurring: z.boolean().default(false),
    consentVersion: z.string().trim().max(80).optional(),
    idempotencyKey: idempotencyKeySchema,
  })
  .strict()
  .refine(
    (value) =>
      value.renewalMode !== "automatic" ||
      (value.acceptRecurring &&
        value.consentVersion === MEMBERSHIP_RECURRING_CONSENT_VERSION &&
        Boolean(value.planVersion)),
    "Automatic renewal requires explicit recurring-payment consent",
  );
export const passQuerySchema = z.object({
  kind: z.enum(["package", "membership"]).optional(),
  clientId: idSchema.optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  search: z.string().trim().max(100).default(""),
});
export const passPeriodSchema = z.object({
  id: idSchema,
  contractId: idSchema,
  index: z.number().int().nonnegative(),
  checkoutId: idSchema,
  status: z.enum(["pending", "active", "upcoming", "expired", "void"]),
  priceCents: moneyCentsSchema,
  startsAt: instantSchema.nullable(),
  endsAt: instantSchema.nullable(),
  availableUses: z.number().int().nonnegative(),
  usedUses: z.number().int().nonnegative(),
  heldUses: z.number().int().nonnegative(),
  returnedUses: z.number().int().nonnegative(),
  remainingAllocationCents: moneyCentsSchema,
  version: z.number().int().positive(),
});
export const passContractSchema = z.object({
  clientName: z.string().optional(),
  id: idSchema,
  planId: idSchema,
  clientId: idSchema,
  kind: z.enum(["package", "membership"]),
  name: z.string(),
  priceCents: moneyCentsSchema,
  currency: z.literal("EUR"),
  includedUses: z.number().int().nonnegative(),
  discountBasisPoints: z.number().int().nonnegative(),
  serviceIds: z.array(idSchema),
  periodMonths: z.number().int().positive().nullable(),
  validityDays: z.number().int().positive().nullable(),
  timezone: z.string(),
  status: z.enum(["pending", "active", "cancelled", "void"]),
  renewalMode: z.enum(["manual", "automatic"]),
  autoPayReady: z.boolean(),
  cancelAtPeriodEnd: z.boolean(),
  version: z.number().int().positive(),
  periods: z.array(passPeriodSchema),
  createdAt: instantSchema,
});
export const passListSchema = z.object({
  passes: z.array(passContractSchema),
  pagination: pageInfoSchema,
});
export const passPurchaseResponseSchema = z.object({
  pass: passContractSchema,
  period: passPeriodSchema,
  checkout: checkoutSchema,
});
export const passPeriodsSchema = z.object({
  periods: z.array(passPeriodSchema),
  pagination: pageInfoSchema,
});
export const membershipCancelSchema = z
  .object({ version: z.number().int().positive(), reason: z.string().trim().min(3).max(300) })
  .strict();
export const benefitRefundQuoteSchema = z
  .object({ periodId: idSchema, paymentId: idSchema, unitCount: z.number().int().min(0).max(1000) })
  .strict();
export const benefitRefundQuoteResponseSchema = z.object({
  accessFee: z.boolean().default(false),
  amountCents: moneyCentsSchema,
  unitCount: z.number().int().nonnegative(),
  excessCents: moneyCentsSchema,
  availableUses: z.number().int().nonnegative(),
});
export const passEligibilitySchema = z.object({
  eligible: z.array(
    z.object({
      period: passPeriodSchema,
      passId: idSchema,
      name: z.string(),
      kind: z.enum(["package", "membership"]),
      lines: z.array(
        z.object({ id: idSchema, description: z.string(), amountCents: moneyCentsSchema }),
      ),
    }),
  ),
});
export type CreateBenefitPlanInput = z.infer<typeof createBenefitPlanSchema>;
export type UpdateBenefitPlanInput = z.infer<typeof updateBenefitPlanSchema>;
export type BenefitPlanTerms = z.infer<typeof benefitPlanTermsSchema>;
export type BenefitPlan = z.infer<typeof benefitPlanSchema>;
export type BenefitPurchaseInput = z.infer<typeof benefitPurchaseSchema>;
export type PassContract = z.infer<typeof passContractSchema>;
export type PassPeriod = z.infer<typeof passPeriodSchema>;
