import { z } from "zod";
import { appointmentStatusSchema } from "./appointments";
import { bookingProtectionSchema } from "./booking-protection";
import { idSchema, instantSchema, pageInfoSchema, syncGenerationSchema } from "./common";
import { giftCardCodeSchema } from "./gift-card-code";
import { staffPermissionsSchema } from "./permissions";
import { checkoutRewardSchema } from "./rewards";

export const moneyCentsSchema = z.number().int().min(0).max(999_999_999);
export const paymentMethodSchema = z.enum([
  "cash",
  "external_card",
  "redsys_card",
  "redsys_bizum",
  "gift_card",
  "package",
  "membership",
]);
export const checkoutStatusSchema = z.enum([
  "open",
  "paid",
  "partially_refunded",
  "refunded",
  "void",
]);
const checkoutHistoryGroupSchema = z.enum(["day", "month"]);
export type CheckoutHistoryGroup = z.infer<typeof checkoutHistoryGroupSchema>;
export const checkoutListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
    search: z.string().trim().max(150).optional(),
    status: checkoutStatusSchema.optional(),
    method: paymentMethodSchema.optional(),
    clientId: idSchema.optional(),
    from: instantSchema.optional(),
    to: instantSchema.optional(),
    groupBy: checkoutHistoryGroupSchema.optional(),
  })
  .refine((value) => !value.from || !value.to || Date.parse(value.from) < Date.parse(value.to), {
    message: "The end must follow the start",
  });
export type CheckoutListQuery = z.infer<typeof checkoutListQuerySchema>;
export const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/);
const catalogPriceReviewSchema = z
  .object({
    expectedUnitAmountCents: moneyCentsSchema,
    unitAmountCents: moneyCentsSchema,
    reason: z.string().trim().min(3).max(200),
  })
  .strict();
export type CatalogPriceReview = z.infer<typeof catalogPriceReviewSchema>;
export const checkoutCatalogPriceSchema = z.object({ unitAmountCents: moneyCentsSchema });

export const checkoutLineInputSchema = z
  .object({
    kind: z.enum(["product", "service", "custom", "gift_card"]),
    productId: idSchema.optional(),
    serviceId: idSchema.optional(),
    giftCardId: idSchema.optional(),
    description: z.string().trim().min(1).max(200).optional(),
    quantity: z.number().int().min(1).max(1000),
    unitAmountCents: moneyCentsSchema.optional(),
    catalogPriceReview: catalogPriceReviewSchema.optional(),
    taxBasisPoints: z.number().int().min(0).max(10000).default(0),
  })
  .strict()
  .superRefine((line, ctx) => {
    if (line.catalogPriceReview && line.kind !== "service" && line.kind !== "product")
      ctx.addIssue({
        code: "custom",
        path: ["catalogPriceReview"],
        message: "Only catalog services and products can have a reviewed unit price",
      });
    if (
      line.kind === "service" &&
      (!line.serviceId ||
        line.productId ||
        line.giftCardId ||
        line.unitAmountCents !== undefined ||
        line.description !== undefined)
    )
      ctx.addIssue({
        code: "custom",
        message: "Services require a catalog id and use the server catalog price",
      });
    if (line.kind !== "service" && line.serviceId)
      ctx.addIssue({ code: "custom", message: "Unexpected service id" });
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
    useClientDiscount: z.boolean().optional(),
    tipCents: moneyCentsSchema.default(0),
    idempotencyKey: idempotencyKeySchema,
  })
  .strict()
  .refine(
    (input) => !input.appointmentId || input.lines.every((line) => !line.catalogPriceReview),
    "Use a separate sale to adjust catalog prices",
  )
  .refine(
    (input) => Boolean(input.appointmentId) || input.lines.length > 0,
    "Checkout needs an appointment or items",
  );
export const startPaymentSchema = z
  .object({
    method: paymentMethodSchema,
    giftCardCode: giftCardCodeSchema.optional(),
    passPeriodId: idSchema.optional(),
    checkoutLineId: idSchema.optional(),
    amountCents: moneyCentsSchema.refine((v) => v > 0),
    idempotencyKey: idempotencyKeySchema,
  })
  .strict()
  .superRefine((input, ctx) => {
    const pass = input.method === "package" || input.method === "membership";
    if (
      pass
        ? !input.passPeriodId || !input.checkoutLineId
        : input.passPeriodId || input.checkoutLineId
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Pass tender requires a period and service line; other methods cannot include them",
      });
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
    review: z
      .strictObject({
        checkoutId: idSchema,
        actorUserId: z.string().min(1).max(256),
        generation: syncGenerationSchema,
      })
      .optional(),
    passQuote: z
      .strictObject({
        periodId: idSchema,
        unitCount: z.number().int().min(0).max(1000),
        generation: syncGenerationSchema,
      })
      .optional(),
  })
  .strict();
export type RefundRequest = z.infer<typeof refundRequestSchema>;
export const reconcileRefundSchema = z
  .object({
    outcome: z.enum(["succeeded", "failed"]),
    reference: z.string().trim().min(8).max(300),
  })
  .strict();
export type BankReconciliation = z.infer<typeof reconcileRefundSchema>;
export const bankPaymentReconciliationResponseSchema = z.object({
  id: idSchema,
  checkoutId: idSchema,
  status: z.enum(["succeeded", "failed", "reconciliation"]),
});
export const cashOpenSchema = z
  .object({ openingCents: moneyCentsSchema, sessionId: idSchema.optional() })
  .strict();
export const importedPriceReviewSchema = z
  .strictObject({
    appointmentVersion: z.number().int().positive(),
    reference: z.string().trim().min(3).max(300),
    lines: z
      .array(z.strictObject({ id: idSchema, amountCents: moneyCentsSchema }))
      .min(1)
      .max(100),
  })
  .refine((input) => new Set(input.lines.map(({ id }) => id)).size === input.lines.length, {
    message: "Review each service exactly once",
    path: ["lines"],
  });
export type ImportedPriceReview = z.infer<typeof importedPriceReviewSchema>;
export const importedPriceReviewPreviewSchema = z.object({
  appointmentVersion: z.number().int().positive(),
  lines: z.array(z.object({ id: idSchema, name: z.string() })).min(1),
});
export type ImportedPriceReviewPreview = z.infer<typeof importedPriceReviewPreviewSchema>;
export const importedSettlementSchema = z.strictObject({
  appointmentVersion: z.number().int().positive(),
  amountCents: moneyCentsSchema,
  reference: z.string().trim().min(3).max(300),
});
export type ImportedSettlement = z.infer<typeof importedSettlementSchema>;
export const importedUnpaidReviewSchema = importedSettlementSchema.omit({ amountCents: true });
export type ImportedUnpaidReview = z.infer<typeof importedUnpaidReviewSchema>;
export const importedUnpaidReviewResponseSchema = importedUnpaidReviewSchema.pick({
  appointmentVersion: true,
});
export const recordedImportedSettlementSchema = importedSettlementSchema
  .omit({ appointmentVersion: true })
  .extend({ recordedAt: z.iso.datetime() });
export const importedSettlementResponseSchema = z.object({
  appointmentVersion: z.number().int().positive(),
  settlement: recordedImportedSettlementSchema.nullable(),
});
export const importedPartialPaymentSchema = importedSettlementSchema.extend({
  amountCents: moneyCentsSchema.min(1),
});
export const externalBalanceSchema = z.object({
  paidInBooksyCents: moneyCentsSchema.min(1),
  dueInCitameCents: moneyCentsSchema.min(1),
});
export const importedPartialPaymentResponseSchema = z.object({
  appointmentVersion: z.number().int().positive(),
  externalBalance: externalBalanceSchema,
});
export const importedPartialPaymentPreviewSchema = z.union([
  importedPartialPaymentResponseSchema,
  z.object({
    appointmentVersion: z.number().int().positive(),
    originalTotalCents: moneyCentsSchema.min(1),
  }),
]);
export type ExternalBalance = z.infer<typeof externalBalanceSchema>;
export const cashCloseSchema = z
  .object({ countedCents: moneyCentsSchema, reviewedExpectedCents: moneyCentsSchema.optional() })
  .strict();
export const cashAdjustmentSchema = z
  .object({
    sessionId: idSchema.optional(),
    kind: z.enum(["deposit", "withdrawal"]),
    amountCents: moneyCentsSchema.refine((v) => v > 0),
    reason: z.string().trim().min(3).max(300),
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();

export const checkoutLineSchema = z.object({
  id: idSchema,
  kind: z.string(),
  serviceId: idSchema.nullable().optional(),
  productId: idSchema.nullable().optional(),
  description: z.string(),
  quantity: z.number().int(),
  unitAmountCents: moneyCentsSchema,
  pricePending: z.boolean().optional(),
  minimumUnitAmountCents: moneyCentsSchema.optional(),
  taxBasisPoints: z.number().int(),
  passPeriodId: idSchema.nullable().optional(),
  discountCents: z.number().int().nonnegative().max(2_147_483_647).optional(),
});
export const checkoutPricesSchema = z
  .object({
    version: z.number().int().positive(),
    lines: z
      .array(z.object({ id: idSchema, unitAmountCents: moneyCentsSchema }).strict())
      .min(1)
      .max(100),
  })
  .strict()
  .refine(
    (s) => new Set(s.lines.map((l) => l.id)).size === s.lines.length,
    "Prices must be unique",
  );
export type CheckoutPrices = z.infer<typeof checkoutPricesSchema>;
export const checkoutPaymentSchema = z.object({
  id: idSchema,
  method: paymentMethodSchema,
  amountCents: moneyCentsSchema,
  status: z.enum(["pending", "succeeded", "failed", "reconciliation"]),
  order: z.string().nullable(),
  merchantInitiated: z.boolean().optional(),
  createdAt: instantSchema,
  updatedAt: instantSchema.optional(),
  reconcileAfter: instantSchema.optional(),
});
export const checkoutSchema = z.object({
  externalBalance: externalBalanceSchema.optional(),
  canRefund: z.boolean().optional(),
  canReturnPoints: z.boolean().optional(),
  canDispatchBankRefunds: z.boolean().optional(),
  bankTenders: z
    .object({
      card: z.boolean(),
      bizum: z.boolean(),
      generation: syncGenerationSchema,
    })
    .optional(),
  refundReviewGeneration: syncGenerationSchema.optional(),
  stockReturnGeneration: syncGenerationSchema.optional(),
  id: idSchema,
  pricingVersion: z.number().int().positive().optional(),
  appointmentId: idSchema.nullable(),
  clientId: idSchema.nullable(),
  staffId: idSchema.nullable().optional(),
  currency: z.literal("EUR"),
  status: checkoutStatusSchema,
  // Gross may exceed the payable limit when a valid discount reduces the total.
  subtotalCents: z.number().int().nonnegative().max(2_147_483_647),
  discountCents: z.number().int().nonnegative().max(2_147_483_647),
  tipCents: moneyCentsSchema,
  taxCents: moneyCentsSchema,
  totalCents: moneyCentsSchema,
  paidCents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  refundedCents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  fulfilledAt: instantSchema.nullable().optional(),
  overpaidCents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  balanceCents: moneyCentsSchema,
  payableCents: moneyCentsSchema.optional(),
  protection: bookingProtectionSchema.nullable().optional(),
  reward: checkoutRewardSchema.nullable().optional(),
  lines: z.array(checkoutLineSchema),
  payments: z.array(checkoutPaymentSchema),
  refunds: z.array(z.lazy(() => checkoutRefundSchema)).default([]),
  createdAt: instantSchema,
});
export const visitCheckoutSchema = z.object({
  groupId: idSchema,
  source: z.enum(["itinerary", "import"]),
  paymentReview: z
    .object({
      token: z.string().regex(/^[a-f0-9]{64}$/),
      totalCents: z.number().int().positive(),
    })
    .nullable(),
  appointments: z.array(
    z.object({
      appointmentId: idSchema,
      staffId: idSchema,
      staffName: z.string(),
      serviceNames: z.array(z.string()),
      startsAt: instantSchema,
      status: appointmentStatusSchema,
      settledExternally: z.boolean(),
      receipt: checkoutSchema.nullable(),
    }),
  ),
});
export type VisitCheckout = z.infer<typeof visitCheckoutSchema>;
const visitPaymentMethodSchema = z.enum(["cash", "external_card"]);
export const visitPaymentInputSchema = z.strictObject({
  method: visitPaymentMethodSchema,
  reviewToken: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: idempotencyKeySchema,
});
export type VisitPaymentInput = z.infer<typeof visitPaymentInputSchema>;
export const visitPaymentSchema = z.object({
  id: idSchema,
  method: visitPaymentMethodSchema,
  totalCents: z.number().int().positive(),
  allocations: z.array(
    z.object({
      paymentId: idSchema,
      receiptId: idSchema,
      amountCents: moneyCentsSchema,
    }),
  ),
});
export type VisitPayment = z.infer<typeof visitPaymentSchema>;
const checkoutGroupTotalSchema = z.object({
  period: z.iso.date(),
  receipts: z.number().int().nonnegative(),
  paidCents: z.number().int().nonnegative(),
  refundedCents: z.number().int().nonnegative(),
});
export type CheckoutGroupTotal = z.infer<typeof checkoutGroupTotalSchema>;
export const checkoutListSchema = pageInfoSchema.extend({
  checkouts: z.array(checkoutSchema),
  groupTotals: z
    .object({ timezone: z.string(), rows: z.array(checkoutGroupTotalSchema) })
    .optional(),
});
export type CheckoutList = z.infer<typeof checkoutListSchema>;

export type CreateCheckoutInput = z.infer<typeof createCheckoutSchema>;
export type StartPaymentInput = z.infer<typeof startPaymentSchema>;
export type Checkout = z.infer<typeof checkoutSchema>;

export const paymentCapabilitiesSchema = z.object({
  permissions: staffPermissionsSchema.optional(),
  provider: z.enum(["none", "redsys"]),
  environment: z.enum(["test", "live"]).nullable(),
  card: z.boolean(),
  giftCards: z.boolean().optional(),
  recurring: z.boolean().optional(),
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
  cancelledAt: instantSchema.nullable().optional(),
  reason: z.string(),
  createdAt: instantSchema,
  updatedAt: instantSchema.optional(),
  reconcileAfter: instantSchema.optional(),
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
