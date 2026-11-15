import { z } from "zod";
import { checkoutSchema, idempotencyKeySchema, moneyCentsSchema } from "./commerce";
import { idSchema, instantSchema, pageInfoSchema } from "./common";
import { giftCardCodeSchema } from "./gift-card-code";

export { giftCardCodeSchema } from "./gift-card-code";
export const giftCardPurchaseSchema = z
  .object({
    amountCents: moneyCentsSchema.positive(),
    label: z.string().trim().max(120).default(""),
    buyerClientId: idSchema.optional(),
    expiresAt: instantSchema.nullable().optional(),
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();
export const giftCardQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  search: z.string().trim().max(100).default(""),
});
export const giftCardSchema = z.object({
  id: idSchema,
  label: z.string(),
  buyerClientId: idSchema.nullable(),
  checkoutId: idSchema,
  amountCents: moneyCentsSchema,
  balanceCents: moneyCentsSchema,
  reservedCents: moneyCentsSchema,
  availableCents: moneyCentsSchema,
  currency: z.literal("EUR"),
  status: z.enum(["pending", "active", "void", "expired"]),
  codeLast4: z.string(),
  codeRevision: z.string(),
  expiresAt: instantSchema.nullable(),
  version: z.number().int().positive(),
  createdAt: instantSchema,
});
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
