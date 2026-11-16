import { sql } from "drizzle-orm";
import { boolean, check, integer, pgTable, text } from "drizzle-orm/pg-core";
import { createdAt, deletedAt, primaryId, updatedAt } from "./helpers";

export const service = pgTable(
  "service",
  {
    id: primaryId(),
    name: text().notNull(),
    description: text(),
    durationMinutes: integer().notNull(),
    /** Cleanup/transition time blocked after the service. */
    bufferMinutes: integer().notNull().default(0),
    priceCents: integer().notNull(),
    currency: text().notNull().default("ARS"),
    resourceVersion: integer().notNull().default(1),
    active: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    check("service_duration_positive", sql`${t.durationMinutes} > 0`),
    check("service_buffer_non_negative", sql`${t.bufferMinutes} >= 0`),
    check("service_price_non_negative", sql`${t.priceCents} >= 0`),
  ],
);
