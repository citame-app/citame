import { sql } from "drizzle-orm";
import { check, index, integer, pgEnum, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { clientProfile } from "./client";
import { createdAt, primaryId, timestamptz, updatedAt } from "./helpers";
export const giftCardStatus = pgEnum("gift_card_status", ["pending", "active", "void"]);
export const giftCard = pgTable(
  "gift_card",
  {
    id: primaryId(),
    label: text().notNull().default(""),
    buyerClientId: uuid().references(() => clientProfile.id),
    amountCents: integer().notNull(),
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
    unique("gift_card_actor_key_unique").on(t.createdBy, t.idempotencyKey),
    index("gift_card_buyer_created_idx").on(t.buyerClientId, t.createdAt),
    check(
      "gift_card_value_valid",
      sql`${t.amountCents} between 1 and 999999999 and ${t.balanceCents} between 0 and ${t.amountCents} and ${t.reservedCents} between 0 and ${t.balanceCents} and ${t.purchaseRefundedCents} between 0 and ${t.amountCents} and ${t.version} > 0 and length(${t.codeLast4}) = 4`,
    ),
  ],
);
