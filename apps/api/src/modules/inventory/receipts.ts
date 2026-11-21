import {
  permissionsFor,
  type StockReceipt,
  type StockReceiptInput,
  type StockReceiptQuery,
  type SupplierInput,
  type SupplierQuery,
} from "@sob/contracts";
import { type Database, inventorySupplier, stockReceipt } from "@sob/db";
import { and, asc, count, desc, eq, ilike, or, sql } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { requirePermission } from "../../auth/policy";
import type { Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import { getSalonSettings } from "../settings/service";
import { prepareOrderDelivery, recordOrderDelivery } from "./orders";
import {
  fingerprint,
  moveStock,
  productRow,
  replay,
  requireCurrentInventoryWriter,
} from "./service";
import { lockActiveWarehouses } from "./warehouse-balances";

function assertGeneration(reviewed: string, current: string) {
  if (reviewed !== current)
    throw new DomainError("sync_generation_changed", "Refresh inventory before saving");
}

export async function listSuppliers(
  db: Database,
  query: SupplierQuery,
  principal: Principal,
  generation: string,
) {
  requirePermission(principal, "writeInventory");
  const { page, pageSize, search, active } = query;
  const pattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
  const filter = and(
    search
      ? or(
          ilike(inventorySupplier.name, pattern),
          ilike(inventorySupplier.email, pattern),
          ilike(inventorySupplier.taxId, pattern),
          ilike(inventorySupplier.phone, pattern),
        )
      : undefined,
    active === undefined ? undefined : eq(inventorySupplier.active, active),
  );
  return db.transaction(
    async (tx) => {
      const suppliers = await tx
        .select()
        .from(inventorySupplier)
        .where(filter)
        .orderBy(asc(inventorySupplier.name), asc(inventorySupplier.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      const [total] = await tx.select({ total: count() }).from(inventorySupplier).where(filter);
      return { suppliers, pagination: { page, pageSize, total: total?.total ?? 0 }, generation };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

export async function saveSupplier(
  db: Database,
  id: string,
  input: SupplierInput,
  principal: Principal,
  generation: string,
) {
  assertGeneration(input.generation, generation);
  return db.transaction(async (tx) => {
    await requireCurrentInventoryWriter(tx, principal.userId);
    const { generation: _, version, ...fields } = input;
    const [existing] =
      version === 0
        ? await tx
            .insert(inventorySupplier)
            .values({ id, ...fields })
            .onConflictDoNothing({ target: inventorySupplier.id })
            .returning()
        : await tx
            .update(inventorySupplier)
            .set({ ...fields, version: version + 1 })
            .where(and(eq(inventorySupplier.id, id), eq(inventorySupplier.version, version)))
            .returning();
    if (!existing) {
      const [current] = await tx
        .select()
        .from(inventorySupplier)
        .where(eq(inventorySupplier.id, id));
      if (
        current?.version === version + 1 &&
        Object.entries(fields).every(
          ([key, value]) => current[key as keyof typeof fields] === value,
        )
      )
        return current;
      throw new DomainError("version_conflict", "Supplier changed; review before saving");
    }
    await recordAudit(tx, {
      actorUserId: principal.userId,
      action: version === 0 ? "inventory.supplier_created" : "inventory.supplier_updated",
      entity: "inventory_supplier",
      entityId: id,
    });
    return existing;
  });
}

export async function getSupplier(db: Database, id: string, principal: Principal) {
  requirePermission(principal, "writeInventory");
  const [supplier] = await db.select().from(inventorySupplier).where(eq(inventorySupplier.id, id));
  if (!supplier) throw new DomainError("not_found", "Supplier not found");
  return supplier;
}

const receiptHeader = {
  id: stockReceipt.id,
  number: stockReceipt.number,
  receivedOn: stockReceipt.receivedOn,
  supplierId: stockReceipt.supplierId,
  supplierName: stockReceipt.supplierName,
  purchaseOrderId: stockReceipt.purchaseOrderId,
  warehouseId: stockReceipt.warehouseId,
  warehouseName: stockReceipt.warehouseName,
  invoiceReference: stockReceipt.invoiceReference,
  notes: stockReceipt.notes,
  lineCount: stockReceipt.lineCount,
  createdAt: stockReceipt.createdAt,
};
function receiptView(row: typeof stockReceipt.$inferSelect, principal: Principal): StockReceipt {
  const { lines, createdAt, createdBy: _, idempotencyKey: __, requestHash: ___, ...header } = row;
  return {
    ...receiptHeaderView({ ...header, createdAt }),
    lines: permissionsFor(principal.role, principal.accessPreset).readCosts
      ? lines
      : lines.map(({ unitCostCents: _, ...line }) => line),
  };
}

function receiptHeaderView({
  purchaseOrderId,
  warehouseId,
  warehouseName,
  createdAt,
  ...header
}: Pick<typeof stockReceipt.$inferSelect, keyof typeof receiptHeader>) {
  return {
    ...header,
    ...(purchaseOrderId ? { purchaseOrderId } : {}),
    ...(warehouseId ? { warehouseId } : {}),
    ...(warehouseName ? { warehouseName } : {}),
    createdAt: createdAt.toISOString(),
  };
}

export async function listStockReceipts(
  db: Database,
  query: StockReceiptQuery,
  principal: Principal,
) {
  requirePermission(principal, "readInventory");
  const { page, pageSize } = query;
  return db.transaction(
    async (tx) => {
      const rows = await tx
        .select(receiptHeader)
        .from(stockReceipt)
        .orderBy(desc(stockReceipt.number))
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      const [total] = await tx.select({ total: count() }).from(stockReceipt);
      return {
        receipts: rows.map(receiptHeaderView),
        pagination: { page, pageSize, total: total?.total ?? 0 },
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

export async function getStockReceipt(db: Database, id: string, principal: Principal) {
  requirePermission(principal, "readInventory");
  const [row] = await db.select().from(stockReceipt).where(eq(stockReceipt.id, id));
  if (!row) throw new DomainError("not_found", "Stock receipt not found");
  return receiptView(row, principal);
}

export async function receiveStockDocument(
  db: Database,
  input: StockReceiptInput,
  principal: Principal,
  generation: string,
  requestedId?: string,
) {
  if (input.actorUserId !== principal.userId)
    throw new DomainError("forbidden", "Switch back to the account that reviewed this receipt");
  return db.transaction(async (tx) => {
    const current = await requireCurrentInventoryWriter(tx, principal.userId);
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`stock-receipt:${principal.userId}:${input.idempotencyKey}`}, 0))`,
    );
    const requestHash = fingerprint(input);
    const [previous] = await tx
      .select()
      .from(stockReceipt)
      .where(
        and(
          eq(stockReceipt.createdBy, principal.userId),
          eq(stockReceipt.idempotencyKey, input.idempotencyKey),
        ),
      );
    if (previous) {
      replay(previous, requestHash);
      return receiptView(previous, current);
    }
    assertGeneration(input.generation, generation);
    const { timezone } = await getSalonSettings(tx);
    const today = Temporal.Now.plainDateISO(timezone).toString();
    if (input.receivedOn > today)
      throw new DomainError("invalid_state", "The delivered stock date cannot be in the future");
    const delivery = await prepareOrderDelivery(tx, input);
    let supplierName: string | null = null;
    if (input.supplierId) {
      const [supplier] = await tx
        .select()
        .from(inventorySupplier)
        .where(eq(inventorySupplier.id, input.supplierId))
        .for("share");
      if (!supplier || (!supplier.active && !delivery))
        throw new DomainError("version_conflict", "Review the supplier for this receipt");
      supplierName = supplier.name;
    }
    // All inventory paths that claim multiple products take their row locks in ID order.
    const ordered = [...input.lines].sort((left, right) =>
      left.productId.localeCompare(right.productId),
    );
    const snapshot = new Map<string, (typeof stockReceipt.$inferSelect)["lines"][number]>();
    for (const line of ordered) {
      const product = await productRow(tx, line.productId, true);
      if ((!product.active && !delivery) || product.version !== line.version)
        throw new DomainError(
          "version_conflict",
          "A product changed; review all lines before receiving",
        );
      snapshot.set(product.id, {
        productId: product.id,
        name: product.name,
        sku: product.sku,
        quantity: line.quantity,
        unitCostCents: product.costCents,
      });
    }
    const warehouseName = input.warehouseId
      ? (await lockActiveWarehouses(tx, [input.warehouseId])).get(input.warehouseId)
      : undefined;
    const [receipt] = await tx
      .insert(stockReceipt)
      .values({
        ...(requestedId ? { id: requestedId } : {}),
        supplierId: input.supplierId,
        supplierName,
        purchaseOrderId: delivery?.order.id,
        warehouseId: input.warehouseId,
        warehouseName,
        receivedOn: input.receivedOn,
        invoiceReference: input.invoiceReference,
        notes: input.notes,
        lines: input.lines.map((line) => snapshot.get(line.productId)!),
        lineCount: input.lines.length,
        createdBy: principal.userId,
        idempotencyKey: input.idempotencyKey,
        requestHash,
      })
      .returning();
    if (!receipt) throw new Error("Stock receipt insert failed");
    for (const line of ordered) {
      await moveStock(
        tx,
        line.productId,
        {
          kind: "receive",
          warehouseId: input.warehouseId,
          quantity: line.quantity,
          version: line.version,
          generation,
          reason: `#${receipt.number} · ${receipt.receivedOn}`,
          idempotencyKey: receipt.id,
        },
        current,
        generation,
        { receiptId: receipt.id },
      );
    }
    if (delivery) await recordOrderDelivery(tx, delivery, new Date());
    await recordAudit(tx, {
      actorUserId: principal.userId,
      action: "inventory.stock_receipt_recorded",
      entity: "stock_receipt",
      entityId: receipt.id,
      metadata: {
        number: receipt.number,
        lineCount: receipt.lineCount,
        ...(delivery ? { purchaseOrderId: delivery.order.id } : {}),
        ...(input.warehouseId ? { warehouseId: input.warehouseId } : {}),
      },
    });
    return receiptView(receipt, current);
  });
}
