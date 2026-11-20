import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { checkout, checkoutLine } from "./commerce";
import { createdAt, primaryId, timestamptz, updatedAt } from "./helpers";
import { retailProduct } from "./inventory-product";

export const stockReservationStatus = pgEnum("stock_reservation_status", [
  "reserved",
  "consumed",
  "released",
]);
export const stockReservation = pgTable(
  "stock_reservation",
  {
    id: primaryId(),
    productId: uuid()
      .notNull()
      .references(() => retailProduct.id),
    checkoutId: uuid()
      .notNull()
      .references(() => checkout.id),
    checkoutLineId: uuid()
      .notNull()
      .references(() => checkoutLine.id)
      .unique(),
    quantity: integer().notNull(),
    status: stockReservationStatus().notNull().default("reserved"),
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("stock_reservation_expiry_idx").on(t.expiresAt).where(sql`${t.status} = 'reserved'`),
    index("stock_reservation_checkout_idx").on(t.checkoutId),
    check("stock_reservation_quantity_positive", sql`${t.quantity} between 1 and 999999999`),
  ],
);
export const stockMovement = pgTable(
  "stock_movement",
  {
    id: primaryId(),
    productId: uuid()
      .notNull()
      .references(() => retailProduct.id),
    quantityDelta: integer().notNull(),
    kind: text().notNull(),
    reason: text().notNull(),
    unitCostCents: integer(),
    checkoutLineId: uuid().references(() => checkoutLine.id),
    createdBy: text().references(() => user.id, { onDelete: "set null" }),
    idempotencyKey: text().notNull(),
    requestHash: text().notNull(),
    ledgerPosition: bigint({ mode: "bigint" }).notNull().default(sql`0`),
    createdAt: createdAt(),
  },
  (t) => [
    unique("stock_movement_idempotency_unique").on(t.productId, t.idempotencyKey),
    uniqueIndex("stock_movement_one_sale_per_line")
      .on(t.checkoutLineId)
      .where(sql`${t.kind} = 'sale'`),
    index("stock_movement_product_created_idx").on(t.productId, t.createdAt),
    uniqueIndex("stock_movement_ledger_position_idx")
      .on(t.ledgerPosition)
      .where(sql`${t.ledgerPosition} > 0`),
    check(
      "stock_movement_kind_valid",
      sql`${t.kind} in ('opening', 'receive', 'consume', 'count', 'sale', 'return')`,
    ),
    check(
      "stock_movement_quantity_valid",
      sql`${t.quantityDelta} between -999999999 and 999999999 and (${t.quantityDelta} <> 0 or ${t.kind} in ('opening', 'count'))`,
    ),
    check(
      "stock_movement_cost_valid",
      sql`${t.unitCostCents} is null or ${t.unitCostCents} between 0 and 999999999`,
    ),
  ],
);
