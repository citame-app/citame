import type {
  StockTransfer,
  StockTransferInput,
  Warehouse,
  WarehouseInput,
  WarehouseStockQuery,
} from "@sob/contracts";
import {
  type Database,
  inventoryWarehouse,
  pgErrorCode,
  retailProduct,
  stockMovement,
  stockTransfer,
  warehouseStock,
} from "@sob/db";
import { and, asc, count, eq, gt, ilike, inArray, or, sql } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { requirePermission } from "../../auth/policy";
import type { Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import { fingerprint, replay, requireCurrentInventoryWriter } from "./service";
import {
  lockActiveWarehouses,
  primaryWarehouse,
  writeWarehouseQuantity,
} from "./warehouse-balances";

function requireGeneration(reviewed: string, current: string) {
  if (reviewed !== current)
    throw new DomainError("sync_generation_changed", "Refresh inventory before saving");
}

function warehouseView({ id, name, active, version }: Warehouse): Warehouse {
  return { id, name, active, version };
}

export async function listWarehouses(db: Database, principal: Principal, generation: string) {
  requirePermission(principal, "readInventory");
  const locations = await db
    .select()
    .from(inventoryWarehouse)
    .orderBy(asc(sql`lower(${inventoryWarehouse.name})`), asc(inventoryWarehouse.id));
  return { warehouses: [primaryWarehouse, ...locations.map(warehouseView)], generation };
}

export async function saveWarehouse(
  db: Database,
  id: string,
  input: WarehouseInput,
  principal: Principal,
  generation: string,
) {
  requireGeneration(input.generation, generation);
  try {
    return await db.transaction(async (tx) => {
      await requireCurrentInventoryWriter(tx, principal.userId);
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`inventory-warehouse:${id}`}, 0))`,
      );
      const [existing] = await tx
        .select()
        .from(inventoryWarehouse)
        .where(eq(inventoryWarehouse.id, id))
        .for("update");
      if (
        existing?.version === input.version + 1 &&
        existing.name === input.name &&
        existing.active === input.active
      )
        return warehouseView(existing);
      if ((existing?.version ?? 0) !== input.version)
        throw new DomainError(
          "version_conflict",
          "The warehouse changed; review its current details",
        );
      if (!input.active && existing?.active) {
        const [stock] = await tx
          .select({ productId: warehouseStock.productId })
          .from(warehouseStock)
          .where(and(eq(warehouseStock.warehouseId, id), gt(warehouseStock.quantity, 0)))
          .limit(1);
        if (stock)
          throw new DomainError(
            "invalid_state",
            "Move or reconcile remaining stock before archiving the warehouse",
          );
      }
      const fields = { name: input.name, active: input.active, version: input.version + 1 };
      const [warehouse] = existing
        ? await tx
            .update(inventoryWarehouse)
            .set(fields)
            .where(eq(inventoryWarehouse.id, id))
            .returning()
        : await tx
            .insert(inventoryWarehouse)
            .values({ id, ...fields })
            .returning();
      if (!warehouse) throw new Error("Warehouse write returned no row");
      await recordAudit(tx, {
        actorUserId: principal.userId,
        entity: "inventory_warehouse",
        entityId: id,
        action: existing ? "inventory.warehouse_updated" : "inventory.warehouse_created",
        metadata: { active: warehouse.active, version: warehouse.version },
      });
      return warehouseView(warehouse);
    });
  } catch (error) {
    if (pgErrorCode(error) === "23505")
      throw new DomainError("invalid_state", "A warehouse already has this name");
    throw error;
  }
}

export async function warehouseInventory(
  db: Database,
  query: WarehouseStockQuery,
  principal: Principal,
  generation: string,
) {
  requirePermission(principal, "readInventory");
  return db.transaction(
    async (tx) => {
      const { page, pageSize, search, warehouseId, productId, availableOnly } = query;
      const term = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
      const [warehouse] =
        warehouseId === "main"
          ? [primaryWarehouse]
          : await tx
              .select()
              .from(inventoryWarehouse)
              .where(eq(inventoryWarehouse.id, warehouseId));
      if (!warehouse) throw new DomainError("not_found", "Warehouse not found");
      const primaryOnHand = sql<number>`${retailProduct.stockOnHand} - ${retailProduct.stockAllocated}`;
      const where = and(
        productId
          ? eq(retailProduct.id, productId)
          : warehouse.id === null
            ? undefined
            : gt(warehouseStock.quantity, 0),
        availableOnly && warehouse.id === null
          ? gt(primaryOnHand, retailProduct.stockReserved)
          : undefined,
        search
          ? or(
              ilike(retailProduct.name, term),
              ilike(retailProduct.sku, term),
              eq(retailProduct.barcode, search),
            )
          : undefined,
      );
      const selection = {
        productId: retailProduct.id,
        sku: retailProduct.sku,
        name: retailProduct.name,
        active: retailProduct.active,
        version: retailProduct.version,
        onHand:
          warehouse.id === null
            ? primaryOnHand
            : sql<number>`coalesce(${warehouseStock.quantity}, 0)`,
        reserved: warehouse.id === null ? retailProduct.stockReserved : sql<number>`0`,
      };
      const join =
        warehouse.id === null
          ? sql`false`
          : and(
              eq(warehouseStock.productId, retailProduct.id),
              eq(warehouseStock.warehouseId, warehouse.id),
            );
      const [total] = await tx
        .select({ total: count() })
        .from(retailProduct)
        .leftJoin(warehouseStock, join)
        .where(where);
      const rows = await tx
        .select(selection)
        .from(retailProduct)
        .leftJoin(warehouseStock, join)
        .where(where)
        .orderBy(asc(retailProduct.name), asc(retailProduct.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      return {
        warehouse: warehouseView(warehouse),
        generation,
        products: rows,
        pagination: { page, pageSize, total: total?.total ?? 0 },
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

function transferDocument(row: typeof stockTransfer.$inferSelect): StockTransfer {
  const { createdAt, createdBy: _, requestHash: __, ...document } = row;
  return { ...document, createdAt: createdAt.toISOString() };
}

export async function getStockTransfer(db: Database, id: string, principal: Principal) {
  requirePermission(principal, "readInventory");
  const [row] = await db.select().from(stockTransfer).where(eq(stockTransfer.id, id));
  if (!row) throw new DomainError("not_found", "Stock transfer not found");
  return transferDocument(row);
}

export async function transferStock(
  db: Database,
  id: string,
  input: StockTransferInput,
  principal: Principal,
  generation: string,
) {
  return db.transaction(async (tx) => {
    await requireCurrentInventoryWriter(tx, principal.userId);
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`stock-transfer:${id}`}, 0))`,
    );
    const requestHash = fingerprint(input);
    const [existing] = await tx.select().from(stockTransfer).where(eq(stockTransfer.id, id));
    if (existing) {
      if (existing.createdBy !== principal.userId)
        throw new DomainError("invalid_state", "Transfer identifier is already in use");
      replay(existing, requestHash);
      return transferDocument(existing);
    }
    requireGeneration(input.generation, generation);
    const { sourceId, destinationId } = input;
    const productIds = input.lines.map((line) => line.productId);
    const warehouseIds = [sourceId, destinationId].filter((item) => item !== null);
    const products = await tx
      .select()
      .from(retailProduct)
      .where(inArray(retailProduct.id, productIds))
      .orderBy(asc(retailProduct.id))
      .for("update");
    const locations = await lockActiveWarehouses(tx, warehouseIds);
    const balances = await tx
      .select()
      .from(warehouseStock)
      .where(
        and(
          inArray(warehouseStock.productId, productIds),
          inArray(warehouseStock.warehouseId, warehouseIds),
        ),
      );
    const balanceByLocation = new Map(
      balances.map((row) => [`${row.warehouseId}:${row.productId}`, row.quantity]),
    );
    const sourceName = sourceId === null ? null : (locations.get(sourceId) ?? null);
    const destinationName = destinationId === null ? null : (locations.get(destinationId) ?? null);
    const byId = new Map(products.map((product) => [product.id, product]));
    const lines: StockTransfer["lines"] = [];
    for (const line of input.lines) {
      const product = byId.get(line.productId);
      if (!product || product.version !== line.version)
        throw new DomainError("version_conflict", "Review the products before transferring stock");
      const available =
        sourceId === null
          ? product.stockOnHand - product.stockReserved - product.stockAllocated
          : (balanceByLocation.get(`${sourceId}:${product.id}`) ?? 0);
      if (line.quantity > available)
        throw new DomainError(
          "version_conflict",
          "Transfer exceeds available stock in the source warehouse",
        );
      lines.push({
        productId: product.id,
        name: product.name,
        sku: product.sku,
        quantity: line.quantity,
      });
    }
    const [saved] = await tx
      .insert(stockTransfer)
      .values({
        id,
        sourceId,
        sourceName,
        destinationId,
        destinationName,
        reason: input.reason,
        lines,
        createdBy: principal.userId,
        requestHash,
      })
      .returning();
    if (!saved) throw new Error("Stock transfer write returned no row");
    const quantities = new Map(lines.map((line) => [line.productId, line.quantity]));
    for (const product of products) {
      const quantity = quantities.get(product.id);
      if (quantity === undefined) throw new Error("Reviewed transfer line not found");
      if (sourceId) {
        const previous = balanceByLocation.get(`${sourceId}:${product.id}`) ?? 0;
        await writeWarehouseQuantity(tx, product.id, sourceId, previous - quantity);
      }
      if (destinationId) {
        const previous = balanceByLocation.get(`${destinationId}:${product.id}`) ?? 0;
        await writeWarehouseQuantity(tx, product.id, destinationId, previous + quantity);
      }
      await tx
        .update(retailProduct)
        .set({ version: product.version + 1 })
        .where(eq(retailProduct.id, product.id));
      const common = {
        productId: product.id,
        reason: input.reason,
        unitCostCents: product.costCents,
        createdBy: principal.userId,
        requestHash,
        transferId: id,
      };
      await tx.insert(stockMovement).values([
        {
          ...common,
          warehouseId: sourceId,
          warehouseName: sourceName,
          quantityDelta: -quantity,
          kind: "consume",
          idempotencyKey: `transfer:${id}:out`,
        },
        {
          ...common,
          warehouseId: destinationId,
          warehouseName: destinationName,
          quantityDelta: quantity,
          kind: "receive",
          idempotencyKey: `transfer:${id}:in`,
        },
      ]);
    }
    await recordAudit(tx, {
      actorUserId: principal.userId,
      entityId: id,
      entity: "stock_transfer",
      action: "inventory.stock_transferred",
      metadata: { sourceId, destinationId, lineCount: lines.length },
    });
    return transferDocument(saved);
  });
}
