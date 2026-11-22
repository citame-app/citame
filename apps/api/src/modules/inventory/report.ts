import { type ProductExportQuery, type ProductFilters, permissionsFor } from "@sob/contracts";
import { type Database, retailProduct } from "@sob/db";
import { and, count, sql } from "drizzle-orm";
import { requirePermission } from "../../auth/policy";
import type { Principal } from "../../auth/principal";
import { streamCsv } from "../../csv";
import { lowStockPredicate, type ProductRow, productFilter, productOrder } from "./service";

export async function inventoryReport(db: Database, filters: ProductFilters, principal: Principal) {
  requirePermission(principal, "readInventory");
  const readCosts = permissionsFor(principal.role, principal.accessPreset).readCosts;
  const [result] = await db
    .select({
      products: count(),
      onHand: sql`coalesce(sum(${retailProduct.stockOnHand}), 0)`.mapWith(Number),
      reserved: sql`coalesce(sum(${retailProduct.stockReserved}), 0)`.mapWith(Number),
      lowStockProducts: sql`count(*) filter (where ${lowStockPredicate})`.mapWith(Number),
      ...(readCosts
        ? {
            knownCostCents: sql<string>`coalesce(sum(${retailProduct.stockOnHand}::numeric
              * ${retailProduct.costCents}), 0)::text`,
            productsMissingCost: sql`count(*) filter (
              where ${retailProduct.costCents} is null and ${retailProduct.stockOnHand} > 0
            )`.mapWith(Number),
          }
        : {}),
    })
    .from(retailProduct)
    .where(productFilter(filters));
  if (!result) throw new Error("Inventory totals query returned no row");
  const { knownCostCents, productsMissingCost, ...counts } = result;
  return {
    ...counts,
    ...(knownCostCents !== undefined && productsMissingCost !== undefined
      ? { valuation: { currency: "EUR" as const, knownCostCents, productsMissingCost } }
      : {}),
  };
}

export function exportInventory(
  db: Database,
  filters: ProductExportQuery,
  principal: Principal,
  headOnly = false,
) {
  requirePermission(principal, "readInventory");
  const readCosts = permissionsFor(principal.role, principal.accessPreset).readCosts;
  const where = productFilter(filters);
  const order = productOrder(filters.sort);
  return streamCsv<{ row: ProductRow; key: string }>(db, {
    filename: "citame-inventory.csv",
    headOnly,
    columns: [
      "sku",
      "barcode",
      "product",
      "category",
      "brand",
      "location",
      "unit",
      "active",
      "resellable",
      "on_hand",
      "reserved",
      "available",
      "low_stock_threshold",
      "target_stock",
      "currency",
      "sale_price_cents",
      ...(readCosts ? ["unit_cost_cents", "known_stock_value_cents"] : []),
      "package_content_quantity",
      "package_content_unit",
    ],
    readBatch: (tx, cursor, limit) =>
      tx
        .select({ row: retailProduct, key: order.cursorKey })
        .from(retailProduct)
        .where(and(where, cursor ? order.after(cursor.key, cursor.row.id) : undefined))
        .orderBy(...order.orderBy)
        .limit(limit),
    cells: ({ row }) => [
      row.sku,
      row.barcode,
      row.name,
      row.category,
      row.brand,
      row.storageLocation,
      row.unitLabel,
      row.active,
      row.resellable,
      row.stockOnHand,
      row.stockReserved,
      row.stockOnHand - row.stockReserved,
      row.lowStockThreshold,
      row.targetStock,
      row.currency,
      row.priceCents,
      ...(readCosts
        ? [
            row.costCents,
            row.costCents === null
              ? null
              : (BigInt(row.stockOnHand) * BigInt(row.costCents)).toString(),
          ]
        : []),
      row.packageContentQuantity,
      row.packageContentUnit,
    ],
  });
}
