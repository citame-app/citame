import { createHash } from "node:crypto";
import type {
  CreateProductInput,
  PackageContent,
  Product,
  ProductFilters,
  ProductQuery,
  ProductSort,
  StockMovementInput,
  StockReturnInput,
  UpdateProductInput,
} from "@sob/contracts";
import { permissionsFor } from "@sob/contracts";
import {
  checkout,
  checkoutLine,
  type Database,
  pgErrorCode,
  retailProduct,
  retailProductPhoto,
  staffProfile,
  stockMovement,
  user,
} from "@sob/db";
import { and, asc, count, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { requirePermission } from "../../auth/policy";
import { loadPrincipal, type Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import type { Tx } from "../../tx";

import { movementView } from "./movement-view";
import {
  lockActiveWarehouses,
  readWarehouseQuantity,
  writeWarehouseQuantity,
} from "./warehouse-balances";

type Connection = Database | Tx;
export type ProductRow = typeof retailProduct.$inferSelect;
function packageColumns(content: PackageContent | null | undefined) {
  return {
    packageContentQuantity: content?.quantity ?? null,
    packageContentUnit: content?.unit ?? null,
  };
}
export const fingerprint = (input: Record<string, unknown>) => {
  const { idempotencyKey: _, ...value } = input;
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
};
export function replay(row: { requestHash: string }, expected: string) {
  if (row.requestHash !== expected)
    throw new DomainError("invalid_state", "Idempotency key belongs to another inventory request");
}
function mapWriteError(error: unknown): never {
  if (pgErrorCode(error) === "23505")
    throw new DomainError("invalid_state", "A product with this SKU or barcode already exists");
  throw error;
}
export function productView(
  row: ProductRow,
  principal: Principal,
  photoVersion?: string | null,
): Product {
  const available = row.stockOnHand - row.stockReserved;
  const permissions = permissionsFor(principal.role, principal.accessPreset);
  return {
    id: row.id,
    name: row.name,
    ...(photoVersion ? { photoVersion } : {}),
    sku: row.sku,
    barcode: row.barcode,
    description: row.description,
    category: row.category,
    brand: row.brand,
    resellable: row.resellable,
    targetStock: row.targetStock,
    currency: "EUR",
    priceCents: row.priceCents,
    ...(permissions.readCosts ? { costCents: row.costCents } : {}),
    taxBasisPoints: row.taxBasisPoints,
    unitLabel: row.unitLabel,
    packageContent:
      row.packageContentQuantity !== null && row.packageContentUnit !== null
        ? { quantity: row.packageContentQuantity, unit: row.packageContentUnit }
        : null,
    canManage: permissions.writeInventory,
    storageLocation: row.storageLocation,
    active: row.active,
    stockOnHand: row.stockOnHand,
    stockReserved: row.stockReserved,
    available,
    ...(row.stockAllocated
      ? {
          stockAllocated: row.stockAllocated,
          sellableAvailable: available - row.stockAllocated,
        }
      : {}),
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
  requirePermission(principal, "readInventory");
  const [product] = await productWithPhoto(db).where(eq(retailProduct.id, id));
  if (!product) throw new DomainError("not_found", "Product not found");
  return productView(product.row, principal, product.photoVersion);
}

function productWithPhoto(db: Connection) {
  return db
    .select({ row: retailProduct, photoVersion: retailProductPhoto.version })
    .from(retailProduct)
    .leftJoin(retailProductPhoto, eq(retailProduct.id, retailProductPhoto.productId));
}
export function productFilter(query: ProductFilters) {
  const escaped = query.search.replace(/[\\%_]/g, "\\$&");
  return and(
    query.category ? eq(retailProduct.category, query.category) : undefined,
    query.brand ? eq(retailProduct.brand, query.brand) : undefined,
    query.resellable === undefined ? undefined : eq(retailProduct.resellable, query.resellable),
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
}

export function productOrder(sort: ProductSort) {
  const column =
    sort === "updated_desc"
      ? retailProduct.updatedAt
      : sort === "stock_asc"
        ? sql`${retailProduct.stockOnHand} - ${retailProduct.stockReserved}`
        : retailProduct.name;
  const descending = sort === "name_desc" || sort === "updated_desc";
  const order = descending ? desc : asc;
  const operator = descending ? sql`<` : sql`>`;
  const cast =
    sort === "updated_desc" ? sql`timestamptz` : sort === "stock_asc" ? sql`integer` : sql`text`;
  return {
    orderBy: [order(column), order(retailProduct.id)],
    // PostgreSQL timestamps have more precision than the Date returned by the driver.
    cursorKey: sql<string>`(${column})::text`,
    after: (key: string, id: string) =>
      sql`(${column}, ${retailProduct.id}) ${operator} (${key}::${cast}, ${id}::uuid)`,
  };
}

export async function listProducts(db: Database, query: ProductQuery, principal: Principal) {
  requirePermission(principal, "readInventory");
  const where = productFilter(query);
  return db.transaction(
    async (tx) => {
      const [total] = await tx.select({ n: count() }).from(retailProduct).where(where);
      const rows = await productWithPhoto(tx)
        .where(where)
        .orderBy(...productOrder(query.sort).orderBy)
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize);
      return {
        products: rows.map(({ row, photoVersion }) => productView(row, principal, photoVersion)),
        pagination: { page: query.page, pageSize: query.pageSize, total: total?.n ?? 0 },
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
export async function requireCurrentInventoryWriter(tx: Tx, id: string) {
  // Hold the account and profile locks in the order used by staff access changes.
  const [account] = await tx
    .select({ role: user.role })
    .from(user)
    .where(eq(user.id, id))
    .for("share");
  if (!account || account.role === "client")
    throw new DomainError("forbidden", "Inventory access has changed");
  if (account.role === "staff") {
    await tx
      .select({ id: staffProfile.id })
      .from(staffProfile)
      .where(and(eq(staffProfile.userId, id), isNull(staffProfile.deletedAt)))
      .for("share");
  }
  const current = await loadPrincipal(tx, id);
  if (!current) throw new DomainError("forbidden", "Inventory access has changed");
  requirePermission(current, "writeInventory");
  return current;
}

export async function createProduct(
  db: Connection,
  input: CreateProductInput,
  principal: Principal,
  requestedProductId?: string,
) {
  requirePermission(principal, "writeInventory");
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`product:${principal.userId}:${input.idempotencyKey}`}, 0))`,
      );
      const writer = await requireCurrentInventoryWriter(tx, principal.userId);
      const { packageContent, ...baseInput } = input;
      const requestHash = fingerprint(packageContent ? input : baseInput);
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
        if (requestedProductId && previous.id !== requestedProductId)
          throw new DomainError("invalid_state", "This request belongs to another product");
        return productView(previous, writer);
      }
      const { openingStock, idempotencyKey, ...fields } = baseInput;
      const [row] = await tx
        .insert(retailProduct)
        .values({
          ...fields,
          ...(requestedProductId ? { id: requestedProductId } : {}),
          ...packageColumns(packageContent),
          sku: input.sku ?? `SKU-${crypto.randomUUID().toUpperCase()}`,
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
      return productView(row, writer);
    });
  } catch (error) {
    mapWriteError(error);
  }
}
export async function updateProduct(
  db: Connection,
  id: string,
  input: UpdateProductInput,
  principal: Principal,
) {
  requirePermission(principal, "writeInventory");
  try {
    return await db.transaction(async (tx) => {
      const writer = await requireCurrentInventoryWriter(tx, principal.userId);
      const row = await productRow(tx, id, true);
      if (row.version !== input.version)
        throw new DomainError("version_conflict", "Product changed; reload before editing");
      const { version: _, packageContent, ...fields } = input;
      const [updated] = await tx
        .update(retailProduct)
        .set({
          ...fields,
          ...(packageContent === undefined ? {} : packageColumns(packageContent)),
          version: row.version + 1,
        })
        .where(eq(retailProduct.id, id))
        .returning();
      if (!updated) throw new Error("Product update failed");
      await recordAudit(tx, {
        actorUserId: principal.userId,
        action: "inventory.product_updated",
        entity: "retail_product",
        entityId: id,
        metadata: {
          fields: [
            ...Object.keys(fields),
            ...(packageContent === undefined ? [] : ["packageContent"]),
          ],
        },
      });
      return productView(updated, writer);
    });
  } catch (error) {
    mapWriteError(error);
  }
}
export async function moveStock(
  db: Connection,
  id: string,
  reviewed: StockMovementInput,
  principal: Principal,
  executingGeneration: string,
  document: { receiptId?: string; movementId?: string; reviewedOnHand?: number } = {},
) {
  requirePermission(principal, "writeInventory");
  const { generation: reviewedGeneration, actorUserId, ...input } = reviewed;
  if (actorUserId !== undefined && principal.userId !== actorUserId)
    throw new DomainError("forbidden", "Switch back to the account that prepared this movement");
  if (reviewedGeneration !== executingGeneration)
    throw new DomainError(
      "sync_generation_changed",
      "Refresh inventory before recording a movement",
    );
  return db.transaction(async (tx) => {
    const current = await requireCurrentInventoryWriter(tx, principal.userId);
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
      if (document.movementId && previous.id !== document.movementId)
        throw new DomainError("invalid_state", "Stock movement identifier is already in use");
      replay(previous, requestHash);
      return productView(row, current);
    }
    if (row.version !== input.version)
      throw new DomainError("version_conflict", "Stock changed; reload before adjusting");
    if (input.kind === "count" && input.warehouseId === undefined && row.stockAllocated > 0)
      throw new DomainError("version_conflict", "Choose the warehouse for this physical count");
    const warehouseId = input.warehouseId === "main" ? undefined : input.warehouseId;
    const locationOnHand = warehouseId
      ? await readWarehouseQuantity(tx, id, warehouseId)
      : row.stockOnHand - row.stockAllocated;
    if (document.reviewedOnHand !== undefined && document.reviewedOnHand !== locationOnHand)
      throw new DomainError(
        "version_conflict",
        "The warehouse balance changed; review the adjustment",
      );
    const warehouseName = warehouseId
      ? (await lockActiveWarehouses(tx, [warehouseId])).get(warehouseId)
      : undefined;
    const delta =
      input.kind === "count"
        ? input.quantity - locationOnHand
        : input.kind === "receive"
          ? input.quantity
          : -input.quantity;
    const next = row.stockOnHand + delta;
    const nextAtLocation = locationOnHand + delta;
    if (nextAtLocation < (warehouseId ? 0 : row.stockReserved) || next > 999999999)
      throw new DomainError(
        "invalid_state",
        "Stock adjustment would consume reserved or unavailable units",
      );
    // Reducing an allocation frees units before reducing the total. Adding units works in reverse.
    if (warehouseId && delta < 0) await writeWarehouseQuantity(tx, id, warehouseId, nextAtLocation);
    const [updated] = await tx
      .update(retailProduct)
      .set({ stockOnHand: next, version: row.version + 1 })
      .where(eq(retailProduct.id, id))
      .returning();
    if (!updated) throw new Error("Stock update failed");
    if (warehouseId && delta > 0) await writeWarehouseQuantity(tx, id, warehouseId, nextAtLocation);
    await tx.insert(stockMovement).values({
      ...(document.movementId ? { id: document.movementId } : {}),
      productId: id,
      receiptId: document.receiptId,
      warehouseId,
      warehouseName,
      quantityDelta: delta,
      kind: input.kind,
      reason: input.reason,
      unitCostCents: row.costCents,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      createdBy: current.userId,
    });
    await recordAudit(tx, {
      actorUserId: current.userId,
      action: "inventory.stock_moved",
      entity: "retail_product",
      entityId: id,
      metadata: { kind: input.kind, quantityDelta: delta, ...(warehouseId ? { warehouseId } : {}) },
    });
    return productView(
      warehouseId ? { ...updated, stockAllocated: row.stockAllocated + delta } : updated,
      current,
    );
  });
}
export async function getStockAdjustment(db: Database, id: string, principal: Principal) {
  requirePermission(principal, "readInventory");
  const [row] = await db
    .select()
    .from(stockMovement)
    .where(
      and(
        eq(stockMovement.id, id),
        inArray(stockMovement.kind, ["receive", "consume", "count"]),
        isNull(stockMovement.receiptId),
        isNull(stockMovement.checkoutLineId),
        isNull(stockMovement.transferId),
      ),
    );
  if (!row) throw new DomainError("not_found", "Stock adjustment not found");
  return movementView(row, permissionsFor(principal.role, principal.accessPreset).readCosts);
}

export async function listMovements(
  db: Database,
  id: string,
  page: number,
  pageSize: number,
  principal: Principal,
) {
  requirePermission(principal, "readInventory");
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
        movements: rows.map((row) =>
          movementView(row, permissionsFor(principal.role, principal.accessPreset).readCosts),
        ),
        pagination: { page, pageSize, total: total?.n ?? 0 },
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
export async function returnStock(
  db: Database,
  reviewed: StockReturnInput,
  principal: Principal,
  executingGeneration: string,
) {
  requirePermission(principal, "writeInventory");
  const { generation, actorUserId, ...input } = reviewed;
  if (actorUserId !== undefined && principal.userId !== actorUserId)
    throw new DomainError("forbidden", "Switch back to the account that prepared this return");
  if (generation !== undefined && generation !== executingGeneration)
    throw new DomainError("sync_generation_changed", "Refresh the receipt before returning stock");
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
