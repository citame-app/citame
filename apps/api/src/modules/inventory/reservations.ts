import {
  checkout,
  checkoutLine,
  checkoutPayment,
  type Database,
  retailProduct,
  stockMovement,
  stockReservation,
} from "@sob/db";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { DomainError } from "../../errors";
import type { Tx } from "../../tx";

export async function loadCheckoutProducts(
  tx: Tx,
  lines: { kind: string; productId?: string; quantity: number }[],
) {
  const quantities = new Map<string, number>();
  for (const line of lines)
    if (line.kind === "product" && line.productId)
      quantities.set(line.productId, (quantities.get(line.productId) ?? 0) + line.quantity);
  const ids = [...quantities.keys()].sort();
  const rows = ids.length
    ? await tx
        .select()
        .from(retailProduct)
        .where(inArray(retailProduct.id, ids))
        .orderBy(asc(retailProduct.id))
        .for("update")
    : [];
  if (rows.length !== ids.length) throw new DomainError("not_found", "Product not found");
  for (const row of rows)
    if (!row.active || row.stockOnHand - row.stockReserved < (quantities.get(row.id) ?? 0))
      throw new DomainError(
        "invalid_state",
        "Product is inactive or has insufficient available stock",
      );
  return new Map(rows.map((row) => [row.id, row]));
}
export async function reserveCheckoutProducts(
  tx: Tx,
  checkoutId: string,
  lines: (typeof checkoutLine.$inferSelect)[],
) {
  const expiresAt = new Date(Date.now() + 30 * 60_000);
  for (const line of [...lines].sort((a, b) =>
    (a.productId ?? "").localeCompare(b.productId ?? ""),
  )) {
    if (line.kind !== "product" || !line.productId) continue;
    await tx
      .update(retailProduct)
      .set({
        stockReserved: sql`${retailProduct.stockReserved} + ${line.quantity}`,
        version: sql`${retailProduct.version} + 1`,
      })
      .where(eq(retailProduct.id, line.productId));
    await tx.insert(stockReservation).values({
      productId: line.productId,
      checkoutId,
      checkoutLineId: line.id,
      quantity: line.quantity,
      expiresAt,
    });
  }
}
async function heldProducts(tx: Tx, checkoutId: string) {
  const holds = await tx
    .select()
    .from(stockReservation)
    .where(
      and(eq(stockReservation.checkoutId, checkoutId), eq(stockReservation.status, "reserved")),
    );
  const ids = [...new Set(holds.map((hold) => hold.productId))].sort();
  if (ids.length)
    await tx
      .select({ id: retailProduct.id })
      .from(retailProduct)
      .where(inArray(retailProduct.id, ids))
      .orderBy(asc(retailProduct.id))
      .for("update");
  return holds;
}
export async function consumeReservedInventory(tx: Tx, checkoutId: string) {
  const holds = await heldProducts(tx, checkoutId);
  for (const hold of holds) {
    const [line] = await tx
      .select()
      .from(checkoutLine)
      .where(eq(checkoutLine.id, hold.checkoutLineId));
    if (!line) throw new Error("Inventory reservation has no checkout line");
    await tx
      .update(retailProduct)
      .set({
        stockOnHand: sql`${retailProduct.stockOnHand} - ${hold.quantity}`,
        stockReserved: sql`${retailProduct.stockReserved} - ${hold.quantity}`,
        version: sql`${retailProduct.version} + 1`,
      })
      .where(eq(retailProduct.id, hold.productId));
    await tx.insert(stockMovement).values({
      productId: hold.productId,
      checkoutLineId: line.id,
      quantityDelta: -hold.quantity,
      kind: "sale",
      reason: "Checkout settled",
      unitCostCents: line.unitCostCents,
      idempotencyKey: `sale-${line.id}`,
      requestHash: checkoutId,
    });
    await tx
      .update(stockReservation)
      .set({ status: "consumed" })
      .where(eq(stockReservation.id, hold.id));
  }
}
export async function releaseCheckoutInventory(tx: Tx, checkoutId: string) {
  for (const hold of await heldProducts(tx, checkoutId)) {
    await tx
      .update(retailProduct)
      .set({
        stockReserved: sql`${retailProduct.stockReserved} - ${hold.quantity}`,
        version: sql`${retailProduct.version} + 1`,
      })
      .where(eq(retailProduct.id, hold.productId));
    await tx
      .update(stockReservation)
      .set({ status: "released" })
      .where(eq(stockReservation.id, hold.id));
  }
}
export async function expireInventoryHolds(
  db: Database,
  now = new Date(),
  batchSize = 50,
): Promise<number> {
  const candidates = await db
    .selectDistinct({ id: stockReservation.checkoutId })
    .from(stockReservation)
    .where(
      and(
        eq(stockReservation.status, "reserved"),
        sql`${stockReservation.expiresAt} <= ${now}`,
        sql`not exists (select 1 from checkout_payment p where p.checkout_id = ${stockReservation.checkoutId} and p.status <> 'failed')`,
      ),
    )
    .limit(batchSize);
  let expired = 0;
  for (const candidate of candidates)
    expired += await db.transaction(async (tx) => {
      const [sale] = await tx
        .select()
        .from(checkout)
        .where(eq(checkout.id, candidate.id))
        .for("update", { skipLocked: true });
      if (sale?.status !== "open" || sale.fulfilledAt) return 0;
      const payments = await tx
        .select({ status: checkoutPayment.status })
        .from(checkoutPayment)
        .where(eq(checkoutPayment.checkoutId, sale.id));
      if (payments.some((payment) => payment.status !== "failed")) return 0;
      const [due] = await tx
        .select({ id: stockReservation.id })
        .from(stockReservation)
        .where(
          and(
            eq(stockReservation.checkoutId, sale.id),
            eq(stockReservation.status, "reserved"),
            sql`${stockReservation.expiresAt} <= ${now}`,
          ),
        )
        .limit(1);
      if (!due) return 0;
      await releaseCheckoutInventory(tx, sale.id);
      await tx.update(checkout).set({ status: "void" }).where(eq(checkout.id, sale.id));
      await recordAudit(tx, {
        actorUserId: null,
        action: "inventory.checkout_expired",
        entity: "checkout",
        entityId: sale.id,
      });
      return 1;
    });
  return expired;
}
