import { sql } from "drizzle-orm";
import { check, integer, pgTable } from "drizzle-orm/pg-core";
import { bunJsonb, updatedAt } from "./helpers";

export const peakPricePolicy = pgTable(
  "peak_price_policy",
  {
    id: integer().primaryKey(),
    version: integer().notNull(),
    rules: bunJsonb<unknown[]>().notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("peak_price_policy_singleton", sql`${t.id} = 1 and ${t.version} > 0`),
    check(
      "peak_price_policy_rules_valid",
      sql`jsonb_typeof(${t.rules}) = 'array' and jsonb_array_length(${t.rules}) <= 100`,
    ),
  ],
);
