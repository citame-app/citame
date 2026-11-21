import type {
  PurchaseOrder,
  PurchaseOrderCommand,
  PurchaseOrderQuery,
  StockReceiptInput,
} from "@sob/contracts";
import {
  type Database,
  inventorySupplier,
  purchaseOrder,
  purchaseOrderCommand,
  purchaseOrderLine,
  retailProduct,
  stockReceipt,
} from "@sob/db";
import { and, asc, count, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { requirePermission } from "../../auth/policy";
import type { Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import type { Tx } from "../../tx";
import { fingerprint, replay, requireCurrentInventoryWriter } from "./service";

type OrderRow = typeof purchaseOrder.$inferSelect;
type OrderLine = typeof purchaseOrderLine.$inferSelect;

function orderHeader(row: OrderRow) {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    orderedAt: row.orderedAt?.toISOString() ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
  };
}

function readLines(db: Tx, id: string) {
  return db
    .select()
    .from(purchaseOrderLine)
    .where(eq(purchaseOrderLine.orderId, id))
    .orderBy(asc(purchaseOrderLine.position));
}

async function details(tx: Tx, row: OrderRow, generation: string): Promise<PurchaseOrder> {
  const lines = await readLines(tx, row.id);
  const receipts = await tx
    .select({
      id: stockReceipt.id,
      number: stockReceipt.number,
      receivedOn: stockReceipt.receivedOn,
    })
    .from(stockReceipt)
    .where(eq(stockReceipt.purchaseOrderId, row.id))
    .orderBy(desc(stockReceipt.number));
  return {
    ...orderHeader(row),
    generation,
    receipts,
    lines: lines.map(({ orderId: _, position: __, ...line }) => line),
  };
}

export async function getPurchaseOrder(
  db: Database,
  id: string,
  principal: Principal,
  generation: string,
) {
  requirePermission(principal, "readInventory");
  return db.transaction(
    async (tx) => {
      const [row] = await tx.select().from(purchaseOrder).where(eq(purchaseOrder.id, id));
      if (!row) throw new DomainError("not_found", "Purchase order not found");
      return details(tx, row, generation);
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

export async function listPurchaseOrders(
  db: Database,
  query: PurchaseOrderQuery,
  principal: Principal,
  generation: string,
) {
  requirePermission(principal, "readInventory");
  const { page, pageSize, search, status } = query;
  const pattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
  const number = /^#?\d{1,10}$/.test(search) ? Number(search.replace(/^#/, "")) : 0;
  const filter = and(
    status ? eq(purchaseOrder.status, status) : undefined,
    search
      ? or(
          ilike(purchaseOrder.supplierName, pattern),
          ilike(purchaseOrder.supplierReference, pattern),
          number > 0 && number <= 2147483647 ? eq(purchaseOrder.number, number) : undefined,
        )
      : undefined,
  );
  return db.transaction(
    async (tx) => {
      const rows = await tx
        .select()
        .from(purchaseOrder)
        .where(filter)
        .orderBy(desc(purchaseOrder.number))
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      const [total] = await tx.select({ total: count() }).from(purchaseOrder).where(filter);
      return {
        orders: rows.map(orderHeader),
        generation,
        pagination: { page, pageSize, total: total?.total ?? 0 },
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

async function lockOrder(tx: Tx, id: string) {
  const [row] = await tx.select().from(purchaseOrder).where(eq(purchaseOrder.id, id)).for("update");
  return row;
}

async function reviewedSupplier(tx: Tx, id: string) {
  const [row] = await tx
    .select({ name: inventorySupplier.name, active: inventorySupplier.active })
    .from(inventorySupplier)
    .where(eq(inventorySupplier.id, id))
    .for("share");
  if (!row?.active)
    throw new DomainError("version_conflict", "Review the supplier before saving this order");
  return row;
}

async function reviewedProducts(tx: Tx, lines: readonly { productId: string }[]) {
  const ids = lines.map((line) => line.productId);
  const rows = await tx
    .select({
      id: retailProduct.id,
      name: retailProduct.name,
      sku: retailProduct.sku,
      active: retailProduct.active,
    })
    .from(retailProduct)
    .where(inArray(retailProduct.id, ids))
    .orderBy(asc(retailProduct.id))
    .for("share");
  if (rows.length !== ids.length || rows.some((row) => !row.active))
    throw new DomainError("version_conflict", "Review products that are no longer active");
  return new Map(rows.map((row) => [row.id, row]));
}

async function saveDraft(
  tx: Tx,
  id: string,
  command: Extract<PurchaseOrderCommand, { action: "save" }>,
  current?: OrderRow,
) {
  if (current && current.status !== "draft")
    throw new DomainError("invalid_state", "Only draft orders can be edited");
  const supplier = await reviewedSupplier(tx, command.supplierId);
  const products = await reviewedProducts(tx, command.lines);
  const fields = {
    supplierId: command.supplierId,
    supplierName: supplier.name,
    supplierReference: command.supplierReference,
    expectedOn: command.expectedOn,
    notes: command.notes,
  };
  const [saved] = current
    ? await tx
        .update(purchaseOrder)
        .set({ ...fields, version: current.version + 1 })
        .where(eq(purchaseOrder.id, id))
        .returning()
    : await tx
        .insert(purchaseOrder)
        .values({ id, ...fields })
        .returning();
  if (!saved) throw new Error("Purchase order write returned no row");
  if (current) await tx.delete(purchaseOrderLine).where(eq(purchaseOrderLine.orderId, id));
  await tx.insert(purchaseOrderLine).values(
    command.lines.map((line, index) => {
      const product = products.get(line.productId);
      if (!product) throw new Error("Reviewed product missing from order");
      return { orderId: id, ...line, position: index + 1, name: product.name, sku: product.sku };
    }),
  );
  return saved;
}

async function transition(tx: Tx, current: OrderRow, action: "order" | "cancel", now: Date) {
  const id = current.id;
  if (action === "order") {
    if (current.status !== "draft")
      throw new DomainError("invalid_state", "Only a draft can be marked ordered");
    const supplier = await reviewedSupplier(tx, current.supplierId);
    const lines = await readLines(tx, id);
    if (!lines.length)
      throw new DomainError("invalid_state", "An order needs at least one product");
    const products = await reviewedProducts(tx, lines);
    for (const line of lines) {
      const product = products.get(line.productId);
      if (!product) throw new Error("Reviewed product missing from order");
      await tx
        .update(purchaseOrderLine)
        .set({ name: product.name, sku: product.sku })
        .where(
          and(eq(purchaseOrderLine.orderId, id), eq(purchaseOrderLine.productId, line.productId)),
        );
    }
    return tx
      .update(purchaseOrder)
      .set({
        status: "ordered",
        orderedAt: now,
        supplierName: supplier.name,
        version: current.version + 1,
      })
      .where(eq(purchaseOrder.id, id))
      .returning();
  }
  if (current.status === "cancelled" || current.status === "received")
    throw new DomainError("invalid_state", "This order is closed");
  return tx
    .update(purchaseOrder)
    .set({ status: "cancelled", closedAt: now, version: current.version + 1 })
    .where(eq(purchaseOrder.id, id))
    .returning();
}

export async function writePurchaseOrder(
  db: Database,
  id: string,
  input: PurchaseOrderCommand,
  principal: Principal,
  generation: string,
  now = new Date(),
) {
  return db.transaction(async (tx) => {
    await requireCurrentInventoryWriter(tx, principal.userId);
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`purchase-order:${id}`}, 0))`,
    );
    const current = await lockOrder(tx, id);
    const expected = fingerprint(input);
    const [previous] = await tx
      .select({ requestHash: purchaseOrderCommand.requestHash })
      .from(purchaseOrderCommand)
      .where(
        and(
          eq(purchaseOrderCommand.orderId, id),
          eq(purchaseOrderCommand.actorUserId, principal.userId),
          eq(purchaseOrderCommand.idempotencyKey, input.idempotencyKey),
        ),
      );
    if (previous && current) {
      replay(previous, expected);
      return details(tx, current, generation);
    }
    if (input.generation !== generation)
      throw new DomainError(
        "sync_generation_changed",
        "Refresh inventory before saving this order",
      );
    if ((current?.version ?? 0) !== input.version)
      throw new DomainError("version_conflict", "This order changed. Review it before saving.");
    let saved: OrderRow | undefined;
    if (input.action === "save") saved = await saveDraft(tx, id, input, current);
    else if (current) [saved] = await transition(tx, current, input.action, now);
    else throw new DomainError("not_found", "Purchase order not found");
    if (!saved) throw new Error("Purchase order transition returned no row");
    await tx.insert(purchaseOrderCommand).values({
      orderId: id,
      actorUserId: principal.userId,
      idempotencyKey: input.idempotencyKey,
      requestHash: expected,
    });
    await recordAudit(tx, {
      actorUserId: principal.userId,
      entity: "purchase_order",
      entityId: id,
      action:
        input.action === "save"
          ? "inventory.purchase_order_saved"
          : input.action === "order"
            ? "inventory.purchase_order_placed"
            : "inventory.purchase_order_cancelled",
      metadata: { version: saved.version, status: saved.status },
    });
    return details(tx, saved, generation);
  });
}

export async function prepareOrderDelivery(tx: Tx, input: StockReceiptInput) {
  if (!input.purchaseOrder) return null;
  const order = await lockOrder(tx, input.purchaseOrder.id);
  if (!order) throw new DomainError("not_found", "Purchase order not found");
  if (
    order.version !== input.purchaseOrder.version ||
    (order.status !== "ordered" && order.status !== "partially_received")
  )
    throw new DomainError(
      "version_conflict",
      "Review the remaining quantities on this purchase order",
    );
  if (input.supplierId !== order.supplierId)
    throw new DomainError(
      "invalid_state",
      "A delivery must use the supplier on its purchase order",
    );
  const lines = await readLines(tx, order.id);
  const received = new Map(input.lines.map((line) => [line.productId, line.quantity]));
  const changed: OrderLine[] = [];
  const updated = lines.map((line) => {
    const quantity = received.get(line.productId) ?? 0;
    const cumulative = line.receivedQuantity + quantity;
    if (cumulative > line.quantity)
      throw new DomainError(
        "version_conflict",
        "A delivery cannot exceed the quantity remaining on the order",
      );
    const updatedLine = { ...line, receivedQuantity: cumulative };
    if (quantity > 0) changed.push(updatedLine);
    received.delete(line.productId);
    return updatedLine;
  });
  if (received.size > 0)
    throw new DomainError("invalid_state", "The delivery contains a product outside this order");
  return {
    order,
    changed,
    complete: updated.every((line) => line.quantity === line.receivedQuantity),
  };
}

export async function recordOrderDelivery(
  tx: Tx,
  delivery: NonNullable<Awaited<ReturnType<typeof prepareOrderDelivery>>>,
  now: Date,
) {
  const { order, changed, complete } = delivery;
  for (const line of changed) {
    await tx
      .update(purchaseOrderLine)
      .set({ receivedQuantity: line.receivedQuantity })
      .where(
        and(
          eq(purchaseOrderLine.orderId, order.id),
          eq(purchaseOrderLine.productId, line.productId),
        ),
      );
  }
  await tx
    .update(purchaseOrder)
    .set({
      version: order.version + 1,
      status: complete ? "received" : "partially_received",
      closedAt: complete ? now : null,
    })
    .where(eq(purchaseOrder.id, order.id));
}
