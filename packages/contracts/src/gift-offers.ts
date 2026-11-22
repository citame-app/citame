import { z } from "zod";
import { idempotencyKeySchema, moneyCentsSchema } from "./commerce";
import { idSchema } from "./common";
import { giftOfferThemeSchema, maximumGiftServices } from "./gift-cards";

export const giftOfferTermsSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).default(""),
    theme: giftOfferThemeSchema.default("rose"),
    amountCents: moneyCentsSchema.positive(),
    priceCents: moneyCentsSchema.positive(),
    validityDays: z.number().int().min(1).max(730).nullable().default(null),
    eligibleServiceIds: z.array(idSchema).max(maximumGiftServices).default([]),
  })
  .strict();
const versionSchema = z.number().int().positive().max(2_147_483_647);
export const giftOfferUpdateSchema = giftOfferTermsSchema.extend({
  version: versionSchema,
  published: z.boolean(),
});
export const giftOfferWriteSchema = giftOfferUpdateSchema.extend({
  version: z.number().int().min(0).max(2_147_483_646),
});
export const giftOfferSchema = giftOfferUpdateSchema.extend({ id: idSchema });
export const giftOfferAdminListSchema = z.object({ offers: z.array(giftOfferSchema) });

const publicGiftOfferSchema = giftOfferSchema
  .omit({ published: true, eligibleServiceIds: true })
  .extend({ eligibleServices: z.array(z.object({ id: idSchema, name: z.string() })) });
export const publicGiftOfferListSchema = z.object({
  offers: z.array(publicGiftOfferSchema),
});
export const giftOfferOrderSchema = z
  .object({
    offerId: idSchema,
    version: versionSchema,
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();

export type GiftOffer = z.infer<typeof giftOfferSchema>;
export type GiftOfferOrder = z.infer<typeof giftOfferOrderSchema>;
export type GiftOfferTerms = z.infer<typeof giftOfferTermsSchema>;
export type GiftOfferUpdate = z.infer<typeof giftOfferWriteSchema>;
export type PublicGiftOffer = z.infer<typeof publicGiftOfferSchema>;
