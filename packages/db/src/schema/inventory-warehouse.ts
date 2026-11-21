import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { bunJsonb, createdAt, updatedAt } from "./helpers";
import { retailProduct } from "./inventory-product";

export const inventoryWarehouse = pgTable(
  "inventory_warehouse",
  {
    id: uuid().primaryKey(),
    name: text().notNull(),
    active: boolean().notNull().default(true),
    version: integer().notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("inventory_warehouse_name_unique").on(sql`lower(${t.name})`),
    check(
      "inventory_warehouse_valid",
      sql`length(btrim(${t.name})) between 1 and 100 and ${t.version} > 0`,
    ),
  ],
);

// Only secondary locations require rows. The primary location retains the original stock.
export const warehouseStock = pgTable(
  "warehouse_stock",
  {
    warehouseId: uuid()
      .notNull()
      .references(() => inventoryWarehouse.id),
    productId: uuid()
      .notNull()
      .references(() => retailProduct.id),
    quantity: integer().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.warehouseId, t.productId] }),
    index("warehouse_stock_product_idx").on(t.productId),
    check("warehouse_stock_quantity_valid", sql`${t.quantity} between 0 and 999999999`),
  ],
);

export const stockTransfer = pgTable(
  "stock_transfer",
  {
    id: uuid().primaryKey(),
    sourceId: uuid().references(() => inventoryWarehouse.id),
    sourceName: text(),
    destinationId: uuid().references(() => inventoryWarehouse.id),
    destinationName: text(),
    reason: text().notNull(),
    lines:
      bunJsonb<{ productId: string; name: string; sku: string; quantity: number }[]>().notNull(),
    createdBy: text().references(() => user.id, { onDelete: "set null" }),
    requestHash: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      "stock_transfer_distinct_locations",
      sql`${t.sourceId} is distinct from ${t.destinationId}`,
    ),
    check(
      "stock_transfer_line_count_valid",
      sql`jsonb_typeof(${t.lines}) = 'array' and jsonb_array_length(${t.lines}) between 1 and 50`,
    ),
  ],
);
