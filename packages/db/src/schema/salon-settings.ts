import { sql } from "drizzle-orm";
import { check, integer, pgTable, text } from "drizzle-orm/pg-core";
import { createdAt, updatedAt } from "./helpers";

/** Single-row table (id is pinned to 1) holding salon-wide configuration. */
export const salonSettings = pgTable(
  "salon_settings",
  {
    id: integer().primaryKey().default(1),
    name: text().notNull(),
    /** IANA timezone; every local-time computation (hours, slots) uses it. */
    timezone: text().notNull(),
    slotGranularityMinutes: integer().notNull().default(15),
    minNoticeMinutes: integer().notNull().default(60),
    maxDaysAhead: integer().notNull().default(60),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("salon_settings_singleton", sql`${t.id} = 1`),
    check("salon_settings_granularity_positive", sql`${t.slotGranularityMinutes} > 0`),
    check("salon_settings_min_notice_non_negative", sql`${t.minNoticeMinutes} >= 0`),
    check("salon_settings_max_days_positive", sql`${t.maxDaysAhead} > 0`),
  ],
);
