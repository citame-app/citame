import { z } from "zod";
import { idempotencyKeySchema, moneyCentsSchema } from "./commerce";
import {
  idSchema,
  instantSchema,
  localDateSchema,
  pageInfoSchema,
  syncGenerationSchema,
} from "./common";
import { reportQuerySchema } from "./reports";

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
  existingPayoutId: idSchema.optional(),
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
export const salesFamilySchema = z.enum([
  "service",
  "product",
  "custom",
  "gift_card",
  "package_purchase",
  "membership_period",
  "other",
  "unallocated",
]);
export const salesFamilyTotalSchema = z.object({
  family: salesFamilySchema,
  amountCents: signedMoney,
  taxCents: signedMoney,
});
export type SalesFamilyTotal = z.infer<typeof salesFamilyTotalSchema>;
export const settledSaleItemSchema = salesFamilyTotalSchema.extend({
  itemId: idSchema.nullable(),
  name: z.string().nullable(),
  quantity: z.number().int().nonnegative().nullable(),
});
export type SettledSaleItem = z.infer<typeof settledSaleItemSchema>;
const forecastRow = z.object({
  date: localDateSchema,
  appointmentLines: z.number().int().positive(),
});
const forecastCurrency = z.string().regex(/^[A-Z]{3}$/);
export const revenueForecastSchema = z.object({
  asOf: instantSchema,
  totals: z.array(z.object({ currency: forecastCurrency, amountCents: aggregateMoney })),
  pendingPriceLines: z.number().int().nonnegative(),
  rows: z.array(
    z.union([
      forecastRow.extend({ currency: forecastCurrency, amountCents: aggregateMoney }),
      forecastRow.extend({ currency: z.null(), amountCents: z.null() }),
    ]),
  ),
});
export type RevenueForecast = z.infer<typeof revenueForecastSchema>;
export const promotionCollectionSchema = z.object({
  name: z.string(),
  code: z.string(),
  collectedCents: aggregateMoney,
  refundedCents: aggregateMoney,
  netCents: signedMoney,
});
export type PromotionCollection = z.infer<typeof promotionCollectionSchema>;
export const salesReportQuerySchema = reportQuerySchema.safeExtend({
  clientId: idSchema.optional(),
});
export type SalesReportQuery = z.infer<typeof salesReportQuerySchema>;
const appointmentCostAmounts = z.object({
  labourCents: moneyCentsSchema.nullable(),
  materialsCents: moneyCentsSchema.nullable(),
});
export const appointmentDirectCostSchema = appointmentCostAmounts.extend({
  version: z.number().int().positive(),
});
export const appointmentDirectCostInputSchema = appointmentCostAmounts
  .extend({
    version: z.number().int().positive().nullable(),
    generation: syncGenerationSchema,
  })
  .strict();
export type AppointmentDirectCostInput = z.infer<typeof appointmentDirectCostInputSchema>;
export const appointmentProfitabilityQuerySchema = salesReportQuerySchema.safeExtend({
  page: z.coerce.number().int().min(1).max(100000).default(1),
});
export type AppointmentProfitabilityQuery = z.infer<typeof appointmentProfitabilityQuerySchema>;
export const appointmentProfitabilityRowSchema = z.object({
  appointmentId: idSchema,
  checkoutId: idSchema,
  staffId: idSchema.nullable(),
  staffName: z.string().nullable(),
  startsAt: instantSchema,
  settledAt: instantSchema,
  netSalesCents: aggregateMoney.nullable(),
  productCostCents: aggregateMoney,
  unknownProductLines: z.number().int().nonnegative(),
  commissionCents: aggregateMoney,
  directCosts: appointmentDirectCostSchema.nullable(),
  marginCents: signedMoney.nullable(),
  reviewReason: z.enum(["missing_costs", "refund_review", "unallocated_receipt"]).nullable(),
});
export type AppointmentProfitabilityRow = z.infer<typeof appointmentProfitabilityRowSchema>;
export const appointmentProfitabilitySchema = z.object({
  generation: syncGenerationSchema,
  from: localDateSchema,
  to: localDateSchema,
  timezone: z.string(),
  rows: z.array(appointmentProfitabilityRowSchema),
  pagination: pageInfoSchema,
});
export type AppointmentProfitability = z.infer<typeof appointmentProfitabilitySchema>;
export const salesReportSchema = z.object({
  from: z.string(),
  to: z.string(),
  timezone: z.string(),
  client: z.object({ id: idSchema, name: z.string() }).optional(),
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
  settledByFamily: z.array(salesFamilyTotalSchema).optional(),
  settledByItem: z.array(settledSaleItemSchema).optional(),
  revenueForecast: revenueForecastSchema.optional(),
  appointmentProfitability: z.literal(true).optional(),
  promotionCollections: z.array(promotionCollectionSchema).optional(),
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
