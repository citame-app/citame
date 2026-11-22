import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { clientProfile } from "./client";
import { type GiftOfferTheme, giftOffer } from "./gift-offer";
import { createdAt, primaryId, timestamptz, updatedAt } from "./helpers";
export const giftCardStatus = pgEnum("gift_card_status", ["pending", "active", "void"]);
export const giftCard = pgTable(
  "gift_card",
  {
    id: primaryId(),
    label: text().notNull().default(""),
    buyerClientId: uuid().references(() => clientProfile.id),
    offerId: uuid().references(() => giftOffer.id),
    offerValidityDays: integer(),
    offerTheme: text().$type<GiftOfferTheme>(),
    amountCents: integer().notNull(),
    eligibleServices: jsonb()
      .$type<{ id: string; name: string }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    balanceCents: integer().notNull().default(0),
    reservedCents: integer().notNull().default(0),
    purchaseRefundedCents: integer().notNull().default(0),
    status: giftCardStatus().notNull().default("pending"),
    codeHash: text().notNull().unique(),
    codeNonce: text().notNull(),
    codeLast4: text().notNull(),
    expiresAt: timestamptz(),
    version: integer().notNull().default(1),
    createdBy: text().references(() => user.id, { onDelete: "set null" }),
    idempotencyKey: text().notNull(),
    requestHash: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      "gift_card_offer_theme_valid",
      sql`${t.offerTheme} is null or (${t.offerId} is not null and ${t.offerTheme} in ('rose', 'sage', 'ink'))`,
    ),
    check(
      "gift_card_offer_validity_valid",
      sql`${t.offerValidityDays} is null or (${t.offerId} is not null and ${t.offerValidityDays} between 1 and 730)`,
    ),
    check(
      "gift_card_eligible_services_valid",
      sql`jsonb_typeof(${t.eligibleServices}) = 'array' and jsonb_array_length(${t.eligibleServices}) <= 50`,
    ),
    unique("gift_card_actor_key_unique").on(t.createdBy, t.idempotencyKey),
    index("gift_card_buyer_created_idx").on(t.buyerClientId, t.createdAt),
    index("gift_card_pending_offer_idx")
      .on(t.createdAt, t.id)
      .where(sql`${t.offerId} is not null and ${t.status} = 'pending'`),
    check(
      "gift_card_value_valid",
      sql`${t.amountCents} between 1 and 999999999 and ${t.balanceCents} between 0 and ${t.amountCents} and ${t.reservedCents} between 0 and ${t.balanceCents} and ${t.purchaseRefundedCents} between 0 and ${t.amountCents} and ${t.version} > 0 and length(${t.codeLast4}) = 4`,
    ),
  ],
);
