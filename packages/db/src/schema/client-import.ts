import { sql } from "drizzle-orm";
import { check, integer, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { createdAt, primaryId } from "./helpers";

/** Idempotent import receipt; original files, notes and contact details are never retained. */
export const clientImport = pgTable(
  "client_import",
  {
    id: primaryId(),
    createdBy: text().references(() => user.id, { onDelete: "set null" }),
    idempotencyKey: text().notNull(),
    requestFingerprint: text().notNull(),
    clientIds: uuid().array().notNull(),
    skipped: integer().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("client_import_actor_key_unique").on(t.createdBy, t.idempotencyKey),
    check(
      "client_import_valid",
      sql`cardinality(${t.clientIds}) between 1 and 500 and ${t.skipped}>=0 and ${t.requestFingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);
