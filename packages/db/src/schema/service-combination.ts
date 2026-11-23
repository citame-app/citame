import { sql } from "drizzle-orm";
import { boolean, check, integer, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { createdAt, primaryId, updatedAt } from "./helpers";
export const serviceCombination = pgTable(
  "service_combination",
  {
    id: primaryId(),
    name: text().notNull(),
    description: text(),
    serviceIds: uuid().array().notNull(),
    fixedPricesCents: integer().array(),
    fixedStaffIds: uuid().array(),
    active: boolean().notNull().default(true),
    version: integer().notNull().default(1),
    createdBy: text()
      .notNull()
      .references(() => user.id),
    idempotencyKey: uuid().notNull(),
    requestFingerprint: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("service_combination_actor_key_unique").on(t.createdBy, t.idempotencyKey),
    check(
      "service_combination_fixed_terms",
      sql`(${t.fixedPricesCents} is null and ${t.fixedStaffIds} is null) or (
        ${t.fixedPricesCents} is not null and ${t.fixedStaffIds} is not null
        and cardinality(${t.fixedPricesCents}) = cardinality(${t.serviceIds})
        and array_position(${t.fixedPricesCents}, null) is null
        and 0 <= all(${t.fixedPricesCents}) and 999999999 >= all(${t.fixedPricesCents})
        and cardinality(${t.fixedStaffIds}) between 1 and 100
        and array_position(${t.fixedStaffIds}, null) is null
      )`,
    ),
    check(
      "service_combination_valid",
      sql`${t.version}>0 and cardinality(${t.serviceIds}) between 2 and 24 and length(btrim(${t.name})) between 1 and 120 and ${t.requestFingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);
