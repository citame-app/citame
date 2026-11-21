import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { bunJsonb, createdAt, primaryId, timestamptz, updatedAt } from "./helpers";
import { retailProduct } from "./inventory-product";

export const inventorySupplier = pgTable(
  "inventory_supplier",
  {
    id: primaryId(),
    name: text().notNull(),
    email: text(),
    phone: text(),
    taxId: text(),
    notes: text(),
    active: boolean().notNull().default(true),
    version: integer().notNull().default(1),
  },
  (t) => [check("inventory_supplier_version_positive", sql`${t.version} > 0`)],
);

export const purchaseOrderStatus = pgEnum("purchase_order_status", [
  "draft",
  "ordered",
  "partially_received",
  "received",
  "cancelled",
]);

export const purchaseOrder = pgTable(
  "purchase_order",
  {
    id: primaryId(),
    number: integer().generatedAlwaysAsIdentity().unique(),
    status: purchaseOrderStatus().notNull().default("draft"),
    version: integer().notNull().default(1),
    supplierId: uuid()
      .notNull()
      .references(() => inventorySupplier.id),
    supplierName: text().notNull(),
    supplierReference: text(),
    expectedOn: date({ mode: "string" }),
    notes: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    orderedAt: timestamptz(),
    closedAt: timestamptz(),
  },
  (t) => [
    index("purchase_order_status_number_idx").on(t.status, t.number),
    check("purchase_order_version_positive", sql`${t.version} > 0`),
    check(
      "purchase_order_dates_valid",
      sql`
    (${t.status} not in ('ordered','partially_received','received') or ${t.orderedAt} is not null)
    and (${t.status} in ('received','cancelled')) = (${t.closedAt} is not null)
    and (${t.status} <> 'draft' or ${t.orderedAt} is null)
  `,
    ),
  ],
);

export const purchaseOrderLine = pgTable(
  "purchase_order_line",
  {
    orderId: uuid()
      .notNull()
      .references(() => purchaseOrder.id),
    productId: uuid()
      .notNull()
      .references(() => retailProduct.id),
    position: integer().notNull(),
    name: text().notNull(),
    sku: text().notNull(),
    quantity: integer().notNull(),
    receivedQuantity: integer().notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.orderId, t.productId] }),
    unique("purchase_order_line_position").on(t.orderId, t.position),
    check(
      "purchase_order_line_quantity_valid",
      sql`${t.quantity} between 1 and 999999999 and ${t.receivedQuantity} between 0 and ${t.quantity} and ${t.position} between 1 and 50`,
    ),
  ],
);

export const purchaseOrderCommand = pgTable(
  "purchase_order_command",
  {
    orderId: uuid()
      .notNull()
      .references(() => purchaseOrder.id),
    actorUserId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    idempotencyKey: text().notNull(),
    requestHash: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.orderId, t.actorUserId, t.idempotencyKey] })],
);

export const stockReceipt = pgTable(
  "stock_receipt",
  {
    id: primaryId(),
    number: integer().generatedAlwaysAsIdentity().unique(),
    supplierId: uuid().references(() => inventorySupplier.id),
    supplierName: text(),
    purchaseOrderId: uuid().references(() => purchaseOrder.id),
    receivedOn: date({ mode: "string" }).notNull(),
    invoiceReference: text(),
    notes: text(),
    lines:
      bunJsonb<
        {
          productId: string;
          name: string;
          sku: string;
          quantity: number;
          unitCostCents: number | null;
        }[]
      >().notNull(),
    lineCount: integer().notNull(),
    createdBy: text().references(() => user.id, { onDelete: "set null" }),
    idempotencyKey: text().notNull(),
    requestHash: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("stock_receipt_actor_key").on(t.createdBy, t.idempotencyKey),
    index("stock_receipt_purchase_order_idx")
      .on(t.purchaseOrderId)
      .where(sql`${t.purchaseOrderId} is not null`),
    check(
      "stock_receipt_lines_valid",
      sql`${t.lineCount} between 1 and 50 and jsonb_array_length(${t.lines}) = ${t.lineCount}`,
    ),
    check(
      "stock_receipt_supplier_snapshot",
      sql`(${t.supplierId} is null) = (${t.supplierName} is null)`,
    ),
  ],
);
