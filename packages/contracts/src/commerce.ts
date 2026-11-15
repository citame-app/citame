import { z } from "zod";
import { idSchema, instantSchema } from "./common";
import { giftCardCodeSchema } from "./gift-card-code";
import { staffPermissionsSchema } from "./permissions";

export const moneyCentsSchema = z.number().int().min(0).max(999_999_999);
export const paymentMethodSchema = z.enum([
  "cash",
  "external_card",
  "redsys_card",
  "redsys_bizum",
  "gift_card",
]);
export const checkoutStatusSchema = z.enum([
  "open",
  "paid",
  "partially_refunded",
  "refunded",
  "void",
]);
export const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/);
export const checkoutLineInputSchema = z
  .object({
    kind: z.enum(["product", "custom", "gift_card"]),
    productId: idSchema.optional(),
    giftCardId: idSchema.optional(),
    description: z.string().trim().min(1).max(200).optional(),
    quantity: z.number().int().min(1).max(1000),
    unitAmountCents: moneyCentsSchema.optional(),
    taxBasisPoints: z.number().int().min(0).max(10000).default(0),
  })
  .strict()
  .superRefine((line, ctx) => {
    if (
      line.kind === "gift_card" &&
      (!line.giftCardId || line.productId || line.unitAmountCents !== undefined)
    )
      ctx.addIssue({
        code: "custom",
        message: "Gift card purchase requires its server-created card",
      });
    if (line.kind !== "gift_card" && line.giftCardId)
      ctx.addIssue({ code: "custom", message: "Unexpected gift card id" });
    if (line.kind === "product" && (!line.productId || line.unitAmountCents !== undefined))
      ctx.addIssue({ code: "custom", message: "Products require an id and use the catalog price" });
    if (
      line.kind === "custom" &&
      (!line.description || line.unitAmountCents === undefined || line.productId)
    )
      ctx.addIssue({ code: "custom", message: "Custom lines require a description and amount" });
  });
export const createCheckoutSchema = z
  .object({
    appointmentId: idSchema.optional(),
    clientId: idSchema.optional(),
    staffId: idSchema.optional(),
    currency: z.literal("EUR").default("EUR"),
    lines: z.array(checkoutLineInputSchema).max(100).default([]),
    discountCents: moneyCentsSchema.default(0),
    tipCents: moneyCentsSchema.default(0),
    idempotencyKey: idempotencyKeySchema,
  })
  .strict()
  .refine(
    (input) => Boolean(input.appointmentId) || input.lines.length > 0,
    "Checkout needs an appointment or items",
  );
export const startPaymentSchema = z
  .object({
    method: paymentMethodSchema,
    giftCardCode: giftCardCodeSchema.optional(),
    amountCents: moneyCentsSchema.refine((v) => v > 0),
    idempotencyKey: idempotencyKeySchema,
  })
  .strict()
  .superRefine((input, ctx) => {
    if ((input.method === "gift_card") !== Boolean(input.giftCardCode))
      ctx.addIssue({
        code: "custom",
        message: "Gift card tender requires its code; other methods cannot include one",
      });
  });
export const refundRequestSchema = z
  .object({
    amountCents: moneyCentsSchema.refine((v) => v > 0),
    reason: z.string().trim().min(3).max(300),
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();
export const reconcileRefundSchema = z
  .object({
    outcome: z.enum(["succeeded", "failed"]),
    reference: z.string().trim().min(8).max(300),
  })
  .strict();
export const cashOpenSchema = z.object({ openingCents: moneyCentsSchema }).strict();
export const cashCloseSchema = z.object({ countedCents: moneyCentsSchema }).strict();
export const cashAdjustmentSchema = z
  .object({
    kind: z.enum(["deposit", "withdrawal"]),
    amountCents: moneyCentsSchema.refine((v) => v > 0),
    reason: z.string().trim().min(3).max(300),
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();

export const checkoutLineSchema = z.object({
  id: idSchema,
  kind: z.string(),
  description: z.string(),
  quantity: z.number().int(),
  unitAmountCents: moneyCentsSchema,
  taxBasisPoints: z.number().int(),
});
export const checkoutPaymentSchema = z.object({
  id: idSchema,
  method: paymentMethodSchema,
  amountCents: moneyCentsSchema,
  status: z.enum(["pending", "succeeded", "failed", "reconciliation"]),
  order: z.string().nullable(),
  createdAt: instantSchema,
  updatedAt: instantSchema.optional(),
});
export const checkoutSchema = z.object({
  id: idSchema,
  appointmentId: idSchema.nullable(),
  clientId: idSchema.nullable(),
  staffId: idSchema.nullable().optional(),
  currency: z.literal("EUR"),
  status: checkoutStatusSchema,
  // Gross may exceed the payable limit when a valid discount reduces the total.
  subtotalCents: z.number().int().nonnegative().max(2_147_483_647),
  discountCents: moneyCentsSchema,
  tipCents: moneyCentsSchema,
  taxCents: moneyCentsSchema,
  totalCents: moneyCentsSchema,
  paidCents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  refundedCents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  fulfilledAt: instantSchema.nullable().optional(),
  overpaidCents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  balanceCents: moneyCentsSchema,
  lines: z.array(checkoutLineSchema),
  payments: z.array(checkoutPaymentSchema),
  refunds: z.array(z.lazy(() => checkoutRefundSchema)).default([]),
  createdAt: instantSchema,
});
export type CreateCheckoutInput = z.infer<typeof createCheckoutSchema>;
export type StartPaymentInput = z.infer<typeof startPaymentSchema>;
export type Checkout = z.infer<typeof checkoutSchema>;

export const paymentCapabilitiesSchema = z.object({
  permissions: staffPermissionsSchema.optional(),
  provider: z.enum(["none", "redsys"]),
  environment: z.enum(["test", "live"]).nullable(),
  card: z.boolean(),
  giftCards: z.boolean().optional(),
  bizum: z.boolean(),
  currency: z.literal("EUR"),
});
export const hostedPaymentFormSchema = z.object({
  action: z.enum([
    "https://sis.redsys.es/sis/realizarPago",
    "https://sis-t.redsys.es:25443/sis/realizarPago",
  ]),
  fields: z.object({
    Ds_MerchantParameters: z.string().min(1).max(8192),
    Ds_Signature: z.string().min(1).max(128),
    Ds_SignatureVersion: z.literal("HMAC_SHA512_V2"),
  }),
});
export const startedPaymentSchema = z.object({
  payment: z.object({
    id: idSchema,
    order: z.string().nullable(),
    amountCents: moneyCentsSchema,
    method: paymentMethodSchema,
    status: z.enum(["pending", "succeeded", "failed", "reconciliation"]),
  }),
  form: hostedPaymentFormSchema.nullable(),
});
export const checkoutRefundSchema = z.object({
  id: idSchema,
  paymentId: idSchema,
  amountCents: moneyCentsSchema,
  status: z.enum(["requested", "dispatched", "succeeded", "failed", "reconciliation"]),
  reason: z.string(),
  createdAt: instantSchema,
  updatedAt: instantSchema.optional(),
});
export const cashSessionSchema = z.object({
  id: idSchema,
  openingCents: moneyCentsSchema,
  openedAt: instantSchema,
  closedAt: instantSchema.nullable(),
  countedCents: moneyCentsSchema.nullable(),
  expectedCents: z.number().int(),
  differenceCents: z.number().int().nullable(),
  movements: z.array(
    z.object({
      id: idSchema,
      kind: z.string(),
      reason: z.string(),
      amountCents: z.number().int(),
      createdAt: instantSchema,
    }),
  ),
});
export type CashSession = z.infer<typeof cashSessionSchema>;
export type HostedPaymentForm = z.infer<typeof hostedPaymentFormSchema>;
