import { sql } from "drizzle-orm";
import { boolean, check, date, integer, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { bunJsonb, createdAt, primaryId } from "./helpers";

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

export const stockReceipt = pgTable(
  "stock_receipt",
  {
    id: primaryId(),
    number: integer().generatedAlwaysAsIdentity().unique(),
    supplierId: uuid().references(() => inventorySupplier.id),
    supplierName: text(),
    receivedOn: date({ mode: "string" }).notNull(),
    invoiceReference: text(),
    notes: text(),
    lines: bunJsonb<
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
