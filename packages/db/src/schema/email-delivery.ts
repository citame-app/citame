import { sql } from "drizzle-orm";
import { check, integer, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { updatedAt } from "./helpers";

export const emailDelivery = pgTable(
  "email_delivery",
  {
    id: integer().primaryKey().default(1),
    revision: uuid().notNull(),
    settings: jsonb().notNull(),
    encryptedSecret: text(),
    updatedAt: updatedAt(),
  },
  (t) => [check("email_delivery_singleton", sql`${t.id} = 1`)],
);
