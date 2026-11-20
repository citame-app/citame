import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  index,
  integer,
  numeric,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
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
    category: text(),
    brand: text(),
    resellable: boolean().notNull().default(true),
    targetStock: integer(),
    priceCents: integer().notNull(),
    currency: text().notNull().default("EUR"),
    costCents: integer(),
    taxBasisPoints: integer().notNull().default(0),
    unitLabel: text().notNull().default("unit"),
    packageContentQuantity: numeric(),
    packageContentUnit: text(),
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
    check(
      "retail_product_target_valid",
      sql`${t.targetStock} is null or ${t.targetStock} between 0 and 999999999`,
    ),
    check("retail_product_sku_canonical", sql`${t.sku} = upper(${t.sku})`),
    check(
      "retail_product_package_content_valid",
      sql`(${t.packageContentQuantity} is null and ${t.packageContentUnit} is null) or
          (${t.packageContentQuantity} is not null and ${t.packageContentUnit} is not null and
           ${t.packageContentQuantity} > 0 and ${t.packageContentQuantity} <= 999999999.999 and
           scale(${t.packageContentQuantity}) <= 3 and length(btrim(${t.packageContentUnit})) between 1 and 20)`,
    ),
  ],
);

const photoBytes = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});

export const retailProductPhoto = pgTable(
  "retail_product_photo",
  {
    productId: uuid()
      .primaryKey()
      .references(() => retailProduct.id, { onDelete: "cascade" }),
    version: uuid().notNull(),
    image: photoBytes().notNull(),
  },
  (t) => [check("retail_product_photo_size", sql`octet_length(${t.image}) between 1 and 262144`)],
);
