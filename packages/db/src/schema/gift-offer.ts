import { sql } from "drizzle-orm";
import { boolean, check, integer, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, primaryId, updatedAt } from "./helpers";

export type GiftOfferTheme = "rose" | "sage" | "ink";

export const giftOffer = pgTable(
  "gift_offer",
  {
    id: primaryId(),
    name: text().notNull(),
    description: text().notNull().default(""),
    theme: text().$type<GiftOfferTheme>().notNull().default("rose"),
    amountCents: integer().notNull(),
    priceCents: integer().notNull(),
    validityDays: integer(),
    eligibleServiceIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    published: boolean().notNull().default(false),
    version: integer().notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      "gift_offer_terms_valid",
      sql`char_length(${t.name}) between 1 and 120 and char_length(${t.description}) <= 500
        and ${t.theme} in ('rose', 'sage', 'ink')
        and ${t.amountCents} between 1 and 999999999 and ${t.priceCents} between 1 and 999999999
        and (${t.validityDays} is null or ${t.validityDays} between 1 and 730)
        and cardinality(${t.eligibleServiceIds}) <= 50 and ${t.version} > 0`,
    ),
  ],
);
