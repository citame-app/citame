import { createHash } from "node:crypto";
import type {
  CreateProductInput,
  Product,
  ProductQuery,
  StockMovementInput,
  StockReturnInput,
  UpdateProductInput,
} from "@sob/contracts";
import {
  checkout,
  checkoutLine,
  type Database,
  pgErrorCode,
  retailProduct,
  stockMovement,
} from "@sob/db";
import { and, asc, count, desc, eq, ilike, or, sql } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { requireRole } from "../../auth/policy";
import type { Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import type { Tx } from "../../tx";

type Connection = Database | Tx;
export type ProductRow = typeof retailProduct.$inferSelect;
const fingerprint = (input: Record<string, unknown>) => {
  const { idempotencyKey: _, ...value } = input;
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
};
function replay(row: { requestHash: string }, expected: string) {
  if (row.requestHash !== expected)
    throw new DomainError("invalid_state", "Idempotency key belongs to another inventory request");
}
function mapWriteError(error: unknown): never {
  if (pgErrorCode(error) === "23505")
    throw new DomainError("invalid_state", "A product with this SKU or barcode already exists");
  throw error;
}
export function productView(row: ProductRow, principal: Principal): Product {
  const available = row.stockOnHand - row.stockReserved;
  return {
    id: row.id,
    name: row.name,
    sku: row.sku,
    barcode: row.barcode,
    description: row.description,
    currency: "EUR",
    priceCents: row.priceCents,
    ...(principal.role === "owner" ? { costCents: row.costCents } : {}),
    taxBasisPoints: row.taxBasisPoints,
    unitLabel: row.unitLabel,
    storageLocation: row.storageLocation,
    active: row.active,
    stockOnHand: row.stockOnHand,
    stockReserved: row.stockReserved,
    available,
    lowStockThreshold: row.lowStockThreshold,
    lowStock: available <= row.lowStockThreshold,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
export async function productRow(db: Connection, id: string, lock = false): Promise<ProductRow> {
  const query = db.select().from(retailProduct).where(eq(retailProduct.id, id));
  const [row] = await (lock ? query.for("update") : query);
  if (!row) throw new DomainError("not_found", "Product not found");
  return row;
}
export async function getProduct(db: Database, id: string, principal: Principal) {
  requireRole(principal, "owner", "staff");
  return productView(await productRow(db, id), principal);
}
export async function listProducts(db: Database, query: ProductQuery, principal: Principal) {
  requireRole(principal, "owner", "staff");
  const escaped = query.search.replace(/[\\%_]/g, "\\$&");
  const where = and(
    query.active === "all" ? undefined : eq(retailProduct.active, query.active === "active"),
    query.search
      ? or(
          ilike(retailProduct.name, `%${escaped}%`),
          ilike(retailProduct.sku, `%${escaped}%`),
          eq(retailProduct.barcode, query.search),
        )
      : undefined,
    query.lowStock
      ? sql`${retailProduct.stockOnHand} - ${retailProduct.stockReserved} <= ${retailProduct.lowStockThreshold}`
      : undefined,
  );
  return db.transaction(
    async (tx) => {
      const [total] = await tx.select({ n: count() }).from(retailProduct).where(where);
      const rows = await tx
        .select()
        .from(retailProduct)
        .where(where)
        .orderBy(asc(retailProduct.name), asc(retailProduct.id))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize);
      return {
        products: rows.map((row) => productView(row, principal)),
        pagination: { page: query.page, pageSize: query.pageSize, total: total?.n ?? 0 },
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
export async function createProduct(db: Database, input: CreateProductInput, principal: Principal) {
  requireRole(principal, "owner");
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`product:${principal.userId}:${input.idempotencyKey}`}, 0))`,
      );
      const requestHash = fingerprint(input);
      const [previous] = await tx
        .select()
        .from(retailProduct)
        .where(
          and(
            eq(retailProduct.createdBy, principal.userId),
            eq(retailProduct.idempotencyKey, input.idempotencyKey),
          ),
        );
      if (previous) {
        replay(previous, requestHash);
        return productView(previous, principal);
      }
      const { openingStock, idempotencyKey, ...fields } = input;
      const [row] = await tx
        .insert(retailProduct)
        .values({
          ...fields,
          costCents: input.costCents ?? null,
          stockOnHand: openingStock,
          idempotencyKey,
          requestHash,
          createdBy: principal.userId,
        })
        .returning();
      if (!row) throw new Error("Product insert failed");
      await tx.insert(stockMovement).values({
        productId: row.id,
        quantityDelta: openingStock,
        kind: "opening",
        reason: "Opening stock",
        unitCostCents: row.costCents,
        idempotencyKey: `opening-${row.id}`,
        requestHash,
        createdBy: principal.userId,
      });
      await recordAudit(tx, {
        actorUserId: principal.userId,
        action: "inventory.product_created",
        entity: "retail_product",
        entityId: row.id,
        metadata: { openingStock, sku: row.sku },
      });
      return productView(row, principal);
    });
  } catch (error) {
    mapWriteError(error);
  }
}
export async function updateProduct(
  db: Database,
  id: string,
  input: UpdateProductInput,
  principal: Principal,
) {
  requireRole(principal, "owner");
  try {
    return await db.transaction(async (tx) => {
      const row = await productRow(tx, id, true);
      if (row.version !== input.version)
        throw new DomainError("version_conflict", "Product changed; reload before editing");
      const { version: _, ...fields } = input;
      const [updated] = await tx
        .update(retailProduct)
        .set({ ...fields, version: row.version + 1 })
        .where(eq(retailProduct.id, id))
        .returning();
      if (!updated) throw new Error("Product update failed");
      await recordAudit(tx, {
        actorUserId: principal.userId,
        action: "inventory.product_updated",
        entity: "retail_product",
        entityId: id,
        metadata: { fields: Object.keys(fields) },
      });
      return productView(updated, principal);
    });
  } catch (error) {
    mapWriteError(error);
  }
}
export async function moveStock(
  db: Database,
  id: string,
  input: StockMovementInput,
  principal: Principal,
) {
  requireRole(principal, "owner");
  return db.transaction(async (tx) => {
    const row = await productRow(tx, id, true);
    const requestHash = fingerprint(input);
    const [previous] = await tx
      .select()
      .from(stockMovement)
      .where(
        and(
          eq(stockMovement.productId, id),
          eq(stockMovement.idempotencyKey, input.idempotencyKey),
        ),
      );
    if (previous) {
      replay(previous, requestHash);
      return productView(row, principal);
    }
    if (row.version !== input.version)
      throw new DomainError("version_conflict", "Stock changed; reload before adjusting");
    const delta =
      input.kind === "count"
        ? input.quantity - row.stockOnHand
        : input.kind === "receive"
          ? input.quantity
          : -input.quantity;
    const next = row.stockOnHand + delta;
    if (next < row.stockReserved || next > 999999999)
      throw new DomainError(
        "invalid_state",
        "Stock adjustment would consume reserved or unavailable units",
      );
    const [updated] = await tx
      .update(retailProduct)
      .set({ stockOnHand: next, version: row.version + 1 })
      .where(eq(retailProduct.id, id))
      .returning();
    if (!updated) throw new Error("Stock update failed");
    await tx.insert(stockMovement).values({
      productId: id,
      quantityDelta: delta,
      kind: input.kind,
      reason: input.reason,
      unitCostCents: row.costCents,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      createdBy: principal.userId,
    });
    await recordAudit(tx, {
      actorUserId: principal.userId,
      action: "inventory.stock_moved",
      entity: "retail_product",
      entityId: id,
      metadata: { kind: input.kind, quantityDelta: delta },
    });
    return productView(updated, principal);
  });
}
export async function listMovements(
  db: Database,
  id: string,
  page: number,
  pageSize: number,
  principal: Principal,
) {
  requireRole(principal, "owner", "staff");
  await productRow(db, id);
  return db.transaction(
    async (tx) => {
      const [total] = await tx
        .select({ n: count() })
        .from(stockMovement)
        .where(eq(stockMovement.productId, id));
      const rows = await tx
        .select()
        .from(stockMovement)
        .where(eq(stockMovement.productId, id))
        .orderBy(desc(stockMovement.createdAt), desc(stockMovement.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      return {
        movements: rows.map((row) => ({
          id: row.id,
          productId: row.productId,
          kind: row.kind,
          quantityDelta: row.quantityDelta,
          reason: row.reason,
          ...(principal.role === "owner" ? { unitCostCents: row.unitCostCents } : {}),
          checkoutLineId: row.checkoutLineId,
          createdAt: row.createdAt.toISOString(),
        })),
        pagination: { page, pageSize, total: total?.n ?? 0 },
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
export async function returnStock(db: Database, input: StockReturnInput, principal: Principal) {
  requireRole(principal, "owner");
  return db.transaction(async (tx) => {
    const [line] = await tx
      .select()
      .from(checkoutLine)
      .where(eq(checkoutLine.id, input.checkoutLineId));
    if (line?.kind !== "product" || !line.productId)
      throw new DomainError("not_found", "Product sale line not found");
    const row = await productRow(tx, line.productId, true);
    const requestHash = fingerprint(input);
    const [previous] = await tx
      .select()
      .from(stockMovement)
      .where(
        and(
          eq(stockMovement.productId, row.id),
          eq(stockMovement.idempotencyKey, input.idempotencyKey),
        ),
      );
    if (previous) {
      replay(previous, requestHash);
      return productView(row, principal);
    }
    const [sale] = await tx.select().from(checkout).where(eq(checkout.id, line.checkoutId));
    if (!sale?.fulfilledAt)
      throw new DomainError("invalid_state", "Only fulfilled product sales can be returned");
    const returns = await tx
      .select()
      .from(stockMovement)
      .where(and(eq(stockMovement.checkoutLineId, line.id), eq(stockMovement.kind, "return")));
    if (
      returns.reduce((sum, move) => sum + move.quantityDelta, 0) + input.quantity > line.quantity ||
      row.stockOnHand + input.quantity > 999999999
    )
      throw new DomainError("invalid_state", "Return exceeds the originally sold quantity");
    const [updated] = await tx
      .update(retailProduct)
      .set({ stockOnHand: row.stockOnHand + input.quantity, version: row.version + 1 })
      .where(eq(retailProduct.id, row.id))
      .returning();
    if (!updated) throw new Error("Stock return update failed");
    await tx.insert(stockMovement).values({
      productId: row.id,
      checkoutLineId: line.id,
      quantityDelta: input.quantity,
      kind: "return",
      reason: input.reason,
      unitCostCents: line.unitCostCents,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      createdBy: principal.userId,
    });
    await recordAudit(tx, {
      actorUserId: principal.userId,
      action: "inventory.product_returned",
      entity: "retail_product",
      entityId: row.id,
      metadata: { checkoutLineId: line.id, quantity: input.quantity },
    });
    return productView(updated, principal);
  });
}
