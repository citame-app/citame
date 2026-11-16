import { sql } from "drizzle-orm";
import { check, date, integer, jsonb, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { createdAt, primaryId, updatedAt } from "./helpers";
import { staffProfile } from "./staff";

/** Null ranges restore the weekly template while preserving a monotonically increasing revision. */
export const dateShift = pgTable(
  "date_shift",
  {
    id: primaryId(),
    staffId: uuid()
      .notNull()
      .references(() => staffProfile.id),
    date: date({ mode: "string" }).notNull(),
    ranges: jsonb().$type<{ startTime: string; endTime: string }[] | null>(),
    version: integer().notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("date_shift_staff_date_unique").on(table.staffId, table.date),
    check("date_shift_version_valid", sql`${table.version}>0`),
  ],
);

/** A reviewed batch is applied once; retries never overwrite later schedule edits. */
export const dateShiftBatch = pgTable(
  "date_shift_batch",
  {
    id: primaryId(),
    staffId: uuid()
      .notNull()
      .references(() => staffProfile.id),
    createdBy: text().references(() => user.id, { onDelete: "set null" }),
    idempotencyKey: text().notNull(),
    requestFingerprint: text().notNull(),
    dates: text().array().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique("date_shift_batch_actor_key_unique").on(table.createdBy, table.idempotencyKey),
    check(
      "date_shift_batch_valid",
      sql`${table.requestFingerprint} ~ '^[a-f0-9]{64}$' and cardinality(${table.dates}) between 1 and 84`,
    ),
  ],
);
