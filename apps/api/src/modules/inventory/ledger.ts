import { permissionsFor, type StockLedgerFilters, type StockLedgerQuery } from "@sob/contracts";
import { type Database, retailProduct, stockMovement } from "@sob/db";
import { and, asc, count, desc, eq, gt, ilike, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { requirePermission } from "../../auth/policy";
import type { Principal } from "../../auth/principal";
import { streamCsv } from "../../csv";
import { DomainError } from "../../errors";
import { movementView } from "./movement-view";

export async function inventoryFacets(db: Database, principal: Principal) {
  requirePermission(principal, "readInventory");
  const [categories, brands] = await Promise.all([
    db
      .selectDistinct({ value: retailProduct.category })
      .from(retailProduct)
      .where(isNotNull(retailProduct.category))
      .orderBy(asc(retailProduct.category)),
    db
      .selectDistinct({ value: retailProduct.brand })
      .from(retailProduct)
      .where(isNotNull(retailProduct.brand))
      .orderBy(asc(retailProduct.brand)),
  ]);
  return {
    categories: categories.flatMap((row) => (row.value ? [row.value] : [])),
    brands: brands.flatMap((row) => (row.value ? [row.value] : [])),
  };
}

function ledgerFilter(query: StockLedgerFilters) {
  const term = `%${query.search.replace(/[\\%_]/g, "\\$&")}%`;
  return and(
    query.kind === "transfer"
      ? isNotNull(stockMovement.transferId)
      : query.kind
        ? and(eq(stockMovement.kind, query.kind), isNull(stockMovement.transferId))
        : undefined,
    query.warehouseId === "main"
      ? isNull(stockMovement.warehouseId)
      : query.warehouseId
        ? eq(stockMovement.warehouseId, query.warehouseId)
        : undefined,
    query.search
      ? or(
          ilike(retailProduct.name, term),
          ilike(retailProduct.sku, term),
          ilike(stockMovement.reason, term),
        )
      : undefined,
  );
}

const movementOrder = [desc(stockMovement.createdAt), desc(stockMovement.id)] as const;
// Preserve PostgreSQL's microseconds in the CSV batch cursor.
const occurredAt = sql<string>`to_char(${stockMovement.createdAt} at time zone 'UTC',
  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

function anchorPosition(anchor: string | undefined, generation: string) {
  if (anchor === undefined) return undefined;
  const separator = anchor.indexOf("~");
  if (anchor.slice(0, separator) !== generation)
    throw new DomainError(
      "sync_generation_changed",
      "Load the latest stock movements after a restore",
    );
  return BigInt(anchor.slice(separator + 1));
}

export async function stockLedger(
  db: Database,
  query: StockLedgerQuery,
  principal: Principal,
  generation: string,
) {
  requirePermission(principal, "readInventory");
  const filters = ledgerFilter(query);
  const requestedPosition = anchorPosition(query.anchor, generation);
  return db.transaction(
    async (tx) => {
      let position = requestedPosition;
      if (position === undefined) {
        const [latest] = await tx
          .select({
            position: sql<string>`coalesce(max(${stockMovement.ledgerPosition}), 0)::text`,
          })
          .from(stockMovement)
          .where(sql`${stockMovement.ledgerPosition} > 0`);
        position = BigInt(latest?.position ?? "0");
      }
      const newer =
        requestedPosition !== undefined
          ? await tx
              .select({ id: stockMovement.id })
              .from(stockMovement)
              .innerJoin(retailProduct, eq(stockMovement.productId, retailProduct.id))
              .where(and(filters, gt(stockMovement.ledgerPosition, position)))
              .limit(1)
          : [];
      const where = and(filters, lte(stockMovement.ledgerPosition, position));
      const [total] = await tx
        .select({ n: count() })
        .from(stockMovement)
        .innerJoin(retailProduct, eq(stockMovement.productId, retailProduct.id))
        .where(where);
      const rows = await tx
        .select({
          movement: stockMovement,
          productName: retailProduct.name,
          sku: retailProduct.sku,
        })
        .from(stockMovement)
        .innerJoin(retailProduct, eq(stockMovement.productId, retailProduct.id))
        .where(where)
        .orderBy(...movementOrder)
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize);
      const costs = permissionsFor(principal.role, principal.accessPreset).readCosts;
      return {
        movements: rows.map(({ movement, productName, sku }) => ({
          ...movementView(movement, costs),
          productName,
          sku,
        })),
        pagination: { page: query.page, pageSize: query.pageSize, total: total?.n ?? 0 },
        anchor: `${generation}~${position}`,
        hasNewer: newer.length > 0,
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

export function exportStockLedger(
  db: Database,
  filters: StockLedgerFilters,
  principal: Principal,
  generation: string,
  headOnly: boolean,
) {
  requirePermission(principal, "readInventory");
  const costs = permissionsFor(principal.role, principal.accessPreset).readCosts;
  const position = anchorPosition(filters.anchor, generation);
  const where = and(
    ledgerFilter(filters),
    position === undefined ? undefined : lte(stockMovement.ledgerPosition, position),
  );
  const fields = {
    id: stockMovement.id,
    productId: stockMovement.productId,
    kind: stockMovement.kind,
    quantityDelta: stockMovement.quantityDelta,
    reason: stockMovement.reason,
    checkoutLineId: stockMovement.checkoutLineId,
    unitCostCents: stockMovement.unitCostCents,
    sku: retailProduct.sku,
    name: retailProduct.name,
    occurredAt,
    warehouseId: stockMovement.warehouseId,
    warehouseName: stockMovement.warehouseName,
    transferId: stockMovement.transferId,
  };
  return streamCsv(db, {
    filename: "citame-stock-movements.csv",
    headOnly,
    columns: [
      "occurred_at_utc",
      "movement_id",
      "product_id",
      "sku",
      "product",
      "kind",
      "quantity_delta",
      "reason",
      "checkout_line_id",
      ...(costs ? ["unit_cost_cents"] : []),
      "warehouse_id",
      "warehouse_name",
      "transfer_id",
    ],
    readBatch: (tx, cursor: { occurredAt: string; id: string } | undefined, limit) =>
      tx
        .select(fields)
        .from(stockMovement)
        .innerJoin(retailProduct, eq(stockMovement.productId, retailProduct.id))
        .where(
          and(
            where,
            cursor
              ? sql`(${stockMovement.createdAt}, ${stockMovement.id}) <
            (${cursor.occurredAt}::timestamptz, ${cursor.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(...movementOrder)
        .limit(limit),
    cells: (row) => [
      row.occurredAt,
      row.id,
      row.productId,
      row.sku,
      row.name,
      row.transferId ? "transfer" : row.kind,
      row.quantityDelta,
      row.reason,
      row.checkoutLineId,
      ...(costs ? [row.unitCostCents] : []),
      row.warehouseId,
      row.warehouseName,
      row.transferId,
    ],
  });
}
