import { z } from "zod";
import { checkoutSchema, idempotencyKeySchema, moneyCentsSchema } from "./commerce";
import { idSchema, instantSchema, pageInfoSchema, syncGenerationSchema } from "./common";
import { giftCardCodeSchema } from "./gift-card-code";

export { giftCardCodeSchema } from "./gift-card-code";

const eligibleGiftServiceSchema = z.object({ id: idSchema, name: z.string() });
export const giftEligibleCatalogSchema = z.object({
  services: z.array(eligibleGiftServiceSchema),
});
export const maximumGiftServices = 50;
export const giftCardPurchaseSchema = z
  .object({
    amountCents: moneyCentsSchema.positive(),
    purchasePriceCents: moneyCentsSchema.positive().optional(),
    eligibleServiceIds: z.array(idSchema).max(maximumGiftServices).optional(),
    label: z.string().trim().max(120).default(""),
    buyerClientId: idSchema.optional(),
    expiresAt: instantSchema.nullable().optional(),
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();
export const giftCardStatusSchema = z.enum(["pending", "active", "void", "expired"]);
export const giftCardQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  search: z.string().trim().max(100).default(""),
  status: giftCardStatusSchema.optional(),
});
export const giftCardSchema = z.object({
  id: idSchema,
  label: z.string(),
  buyerClientId: idSchema.nullable(),
  checkoutId: idSchema,
  amountCents: moneyCentsSchema,
  purchasePriceCents: moneyCentsSchema.positive().optional(),
  eligibleServices: z
    .array(z.object({ id: idSchema, name: z.string() }))
    .max(50)
    .optional(),
  balanceCents: moneyCentsSchema,
  reservedCents: moneyCentsSchema,
  availableCents: moneyCentsSchema,
  currency: z.literal("EUR"),
  status: giftCardStatusSchema,
  codeLast4: z.string(),
  codeRevision: z.string(),
  expiresAt: instantSchema.nullable(),
  version: z.number().int().positive(),
  createdAt: instantSchema,
});
export const giftReplicaScopeSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const giftReplicaStampSchema = z.object({
  scope: giftReplicaScopeSchema,
  generation: syncGenerationSchema,
});
export const giftReplicaQuerySchema = giftCardQuerySchema.pick({ page: true }).strict();
export const giftReplicaPageSize = 128;
export const giftReplicaPageSchema = giftReplicaStampSchema.extend({
  revision: z.number().int().nonnegative(),
  through: z.number().int().nonnegative(),
  rows: z.array(giftCardSchema.omit({ buyerClientId: true })).max(giftReplicaPageSize),
  hasMore: z.boolean(),
});
export type GiftReplicaPage = z.infer<typeof giftReplicaPageSchema>;

export const giftCardListSchema = z.object({
  cards: z.array(giftCardSchema),
  pagination: pageInfoSchema,
});
export const giftCardPurchaseResponseSchema = z.object({
  card: giftCardSchema,
  checkout: checkoutSchema,
});
export const giftCardCodeInputSchema = z.object({ code: giftCardCodeSchema }).strict();
export const giftCardBalanceSchema = giftCardSchema.pick({
  eligibleServices: true,
  balanceCents: true,
  reservedCents: true,
  availableCents: true,
  currency: true,
  status: true,
  codeLast4: true,
  expiresAt: true,
});
export const giftCardRevealSchema = z.object({ code: z.string(), card: giftCardSchema });
export const giftCardExpirySchema = z
  .object({
    expiresAt: instantSchema.nullable(),
    reason: z.string().trim().min(3).max(300),
    version: z.number().int().positive(),
  })
  .strict();
export const giftCardReissueSchema = z
  .object({ reason: z.string().trim().min(3).max(300), version: z.number().int().positive() })
  .strict();
export type GiftCardPurchaseInput = z.infer<typeof giftCardPurchaseSchema>;
export type GiftCard = z.infer<typeof giftCardSchema>;

export const giftCardMovementListSchema = z.object({
  replica: giftReplicaStampSchema.optional(),
  movements: z.array(
    z.object({
      id: idSchema,
      kind: z.enum([
        "activation",
        "redemption",
        "redemption_refund",
        "purchase_refund",
        "purchase_refund_reversal",
      ]),
      amountCents: z.number().int(),
      createdAt: instantSchema,
    }),
  ),
  pagination: pageInfoSchema,
});
