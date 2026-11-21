import { z } from "zod";
import { idempotencyKeySchema, moneyCentsSchema } from "./commerce";
import { idSchema, instantSchema, pageInfoSchema, syncGenerationSchema } from "./common";

const basisPoints = z.number().int().min(0).max(10000);
const signedMoney = z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const aggregateMoney = signedMoney.nonnegative();
export const commissionPolicyInputSchema = z
  .object({
    serviceBasisPoints: basisPoints,
    productBasisPoints: basisPoints,
    version: z.number().int().positive().nullable(),
  })
  .strict();
export const commissionPolicySchema = z.object({
  staffId: idSchema,
  serviceBasisPoints: basisPoints,
  productBasisPoints: basisPoints,
  version: z.number().int().positive().nullable(),
});
export const commissionPayoutInputSchema = z
  .object({
    amountCents: moneyCentsSchema.positive(),
    reference: z.string().trim().min(8).max(300),
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();
export const commissionPayoutSchema = z.object({
  id: idSchema,
  staffId: idSchema,
  amountCents: moneyCentsSchema,
  reference: z.string(),
  createdAt: instantSchema,
});
export const reviewedCommissionPolicySchema = commissionPolicySchema.extend({
  generation: syncGenerationSchema,
});
export const reviewedCommissionRateInputSchema = commissionPolicyInputSchema.extend({
  generation: syncGenerationSchema,
});
export const reviewedCommissionPayoutInputSchema = commissionPayoutInputSchema.extend({
  generation: syncGenerationSchema,
  actorUserId: z.string().min(1).max(256),
  alreadyRecorded: z.literal(true).optional(),
});
export const commissionScopeSchema = z.object({
  staffId: idSchema.nullable(),
  canChooseStaff: z.boolean(),
  canManage: z.boolean(),
});
export type CommissionScope = z.infer<typeof commissionScopeSchema>;
export const commissionStatementSchema = z.object({
  staffId: idSchema,
  generation: syncGenerationSchema.optional(),
  earnedCents: aggregateMoney,
  paidCents: aggregateMoney,
  outstandingCents: signedMoney,
  accruals: z.array(
    z.object({
      id: idSchema,
      checkoutId: idSchema,
      description: z.string(),
      kind: z.string(),
      basisCents: moneyCentsSchema,
      rateBasisPoints: basisPoints,
      originalCents: moneyCentsSchema,
      adjustedCents: moneyCentsSchema,
      createdAt: instantSchema,
    }),
  ),
  payouts: z.array(commissionPayoutSchema),
  pagination: pageInfoSchema,
  payoutPagination: pageInfoSchema,
});
export const salesReportSchema = z.object({
  from: z.string(),
  to: z.string(),
  timezone: z.string(),
  collectedCents: aggregateMoney,
  refundedCents: aggregateMoney,
  netCollectedCents: signedMoney,
  storedValueAppliedCents: aggregateMoney.default(0),
  storedValueReturnedCents: aggregateMoney.default(0),
  giftValueIssuedCents: aggregateMoney.default(0),
  prepaidAppliedCents: aggregateMoney.default(0),
  prepaidReturnedCents: aggregateMoney.default(0),
  prepaidAllocatedCents: aggregateMoney.default(0),
  prepaidAllocationReturnedCents: aggregateMoney.default(0),
  membershipAccessFeesCents: aggregateMoney.default(0),
  bookingFeesCents: signedMoney.default(0),
  soldCents: aggregateMoney,
  includedTaxCents: aggregateMoney,
  tipsCents: aggregateMoney,
  productCostCents: aggregateMoney,
  unknownCostLines: z.number().int().nonnegative(),
  methods: z.array(
    z.object({ method: z.string(), collectedCents: aggregateMoney, refundedCents: aggregateMoney }),
  ),
  cashSessions: z.array(
    z.object({
      id: idSchema,
      openedAt: instantSchema,
      closedAt: instantSchema.nullable(),
      openingCents: moneyCentsSchema,
      expectedCents: moneyCentsSchema.nullable(),
      countedCents: moneyCentsSchema.nullable(),
      differenceCents: signedMoney.nullable(),
    }),
  ),
});
export type CommissionPolicyInput = z.infer<typeof commissionPolicyInputSchema>;
export type CommissionPayoutInput = z.infer<typeof commissionPayoutInputSchema>;
export type CommissionStatement = z.infer<typeof commissionStatementSchema>;
export type SalesReport = z.infer<typeof salesReportSchema>;
