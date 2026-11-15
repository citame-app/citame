import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgTable, text, unique } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { createdAt, primaryId, updatedAt } from "./helpers";

export const retailProduct = pgTable(
  "retail_product",
  {
    id: primaryId(),
    name: text().notNull(),
    sku: text().notNull().unique(),
    barcode: text().unique(),
    description: text(),
    priceCents: integer().notNull(),
    currency: text().notNull().default("EUR"),
    costCents: integer(),
    taxBasisPoints: integer().notNull().default(0),
    unitLabel: text().notNull().default("unit"),
    storageLocation: text(),
    active: boolean().notNull().default(true),
    stockOnHand: integer().notNull().default(0),
    stockReserved: integer().notNull().default(0),
    lowStockThreshold: integer().notNull().default(0),
    version: integer().notNull().default(1),
    createdBy: text().references(() => user.id, { onDelete: "set null" }),
    idempotencyKey: text().notNull(),
    requestHash: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("retail_product_actor_idempotency_unique").on(t.createdBy, t.idempotencyKey),
    index("retail_product_name_idx").on(t.name),
    check(
      "retail_product_stock_valid",
      sql`${t.stockOnHand} between 0 and 999999999 and ${t.stockReserved} between 0 and ${t.stockOnHand} and ${t.lowStockThreshold} between 0 and 999999999 and ${t.version} > 0`,
    ),
    check(
      "retail_product_money_valid",
      sql`${t.currency} = 'EUR' and ${t.priceCents} between 0 and 999999999 and (${t.costCents} is null or ${t.costCents} between 0 and 999999999) and ${t.taxBasisPoints} between 0 and 10000`,
    ),
    check("retail_product_sku_canonical", sql`${t.sku} = upper(${t.sku})`),
  ],
);
