import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { clientProfile } from "./client";
import { checkout } from "./commerce";
import { createdAt, primaryId, timestamptz, updatedAt } from "./helpers";

export const stampProgram = pgTable(
  "stamp_program",
  {
    id: integer().primaryKey().default(1),
    terms: jsonb().notNull(),
    version: integer().notNull().default(1),
    minimumCardVersion: integer().notNull().default(1),
    lastRequest: text(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      "stamp_program_singleton",
      sql`${t.id} = 1 and ${t.minimumCardVersion} between 1 and ${t.version}`,
    ),
  ],
);

export const stampCard = pgTable(
  "stamp_card",
  {
    id: primaryId(),
    clientId: uuid()
      .notNull()
      .references(() => clientProfile.id),
    programVersion: integer().notNull(),
    program: jsonb().notNull(),
    version: integer().notNull().default(1),
    stamps: integer().notNull(),
    stampExpiresAt: timestamptz(),
    stampExpiryOverridden: boolean().notNull().default(false),
    rewardExpiresAt: timestamptz(),
    completedAt: timestamptz(),
    rewardIssuedAt: timestamptz(),
    redeemedAt: timestamptz(),
    voidedAt: timestamptz(),
    needsReview: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("stamp_card_client_idx").on(t.clientId, t.createdAt),
    check("stamp_card_revision", sql`${t.version} > 0 and ${t.programVersion} > 0`),
    check("stamp_card_count", sql`${t.stamps} between 0 and 15`),
    check(
      "stamp_card_lifecycle",
      sql`(${t.rewardIssuedAt} is null or ${t.completedAt} is not null)
        and (${t.redeemedAt} is null or ${t.rewardIssuedAt} is not null)`,
    ),
  ],
);

export const stampCardEvent = pgTable(
  "stamp_card_event",
  {
    source: text().primaryKey(),
    cardId: uuid()
      .notNull()
      .references(() => stampCard.id),
    checkoutId: uuid()
      .unique()
      .references(() => checkout.id),
    requestHash: text(),
    revokedAt: timestamptz(),
    createdAt: createdAt(),
  },
  (t) => [index("stamp_card_event_card_idx").on(t.cardId)],
);
