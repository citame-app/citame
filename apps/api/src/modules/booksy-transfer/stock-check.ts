import { createCheckoutSchema, stockMovementInputSchema, type Product } from "@sob/contracts";
import { retailProduct, stockMovement } from "@sob/db";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Principal } from "../../auth/principal";
import type { Tx } from "../../tx";
import { createCheckoutInTransaction } from "../commerce/service";
import { moveStock, productRow, updateProduct } from "../inventory/service";
import { mustReject } from "./rehearsal-assert";

export const restoredStockEvidenceSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("empty") }),
  z.object({
    status: z.literal("exercised"),
    staleGenerationRejected: z.literal(true),
    otherAccountRejected: z.literal(true),
    staleVersionRejected: z.literal(true),
    movementReplayRecordedOnce: z.literal(true),
    modifiedReplayRejected: z.literal(true),
    countBelowReservedRejected: z.literal(true),
    countPreservedPackAndReservations: z.literal(true),
    orderedLedgerPositionsVerified: z.literal(true),
  }),
]);

/** Exercises imported stock through the normal services inside the caller's rollback transaction. */
export async function checkRestoredStock(
  tx: Tx,
  operator: Principal,
): Promise<z.infer<typeof restoredStockEvidenceSchema>> {
  const [product] = await tx.select().from(retailProduct).orderBy(asc(retailProduct.id)).limit(1);
  if (!product) return { status: "empty" as const };
  const [head] = await tx
    .select({ position: sql<string>`coalesce(max(${stockMovement.ledgerPosition}), 0)::text` })
    .from(stockMovement)
    .where(sql`${stockMovement.ledgerPosition} > 0`);

  const generation = `rehearsal-${Bun.randomUUIDv7()}`;
  const pack = { quantity: "125.5", unit: "ml" };
  const prepared = await updateProduct(
    tx,
    product.id,
    {
      version: product.version,
      active: true,
      resellable: true,
      packageContent: pack,
      priceCents: product.priceCents || 100,
    },
    operator,
  );
  const command = {
    version: prepared.version,
    generation,
    actorUserId: operator.userId,
  };
  // Leave room for both a paid-price reservation and a delivery, including on zero-stock or
  // full-stock imports. The normal services set up the sample inside the same rollback.
  const startingStock = Math.min(999_999_998, Math.max(1, product.stockOnHand));
  if (prepared.stockOnHand !== startingStock) {
    await moveStock(
      tx,
      product.id,
      stockMovementInputSchema.parse({
        ...command,
        kind: "count",
        quantity: startingStock,
        reason: "Synthetic recovery opening count",
        idempotencyKey: Bun.randomUUIDv7(),
      }),
      operator,
      generation,
    );
  }
  const checkout = await createCheckoutInTransaction(
    tx,
    createCheckoutSchema.parse({
      lines: [{ kind: "product", productId: product.id, quantity: 1 }],
      idempotencyKey: Bun.randomUUIDv7(),
    }),
    operator,
  );
  const baseline = await productRow(tx, product.id);
  if (
    checkout.status !== "open" ||
    baseline.stockReserved !== 1 ||
    baseline.stockOnHand !== startingStock ||
    baseline.packageContentQuantity !== pack.quantity ||
    baseline.packageContentUnit !== pack.unit
  )
    throw new Error("The restored inventory sample could not reserve stock and save pack content");

  const send = (payload: unknown) =>
    moveStock(tx, product.id, stockMovementInputSchema.parse(payload), operator, generation);
  const request = {
    ...command,
    version: baseline.version,
    kind: "receive",
    quantity: 1,
    reason: "Synthetic recovery delivery",
    idempotencyKey: Bun.randomUUIDv7(),
  };
  const assertStock = (view: Product, stock: number, version: number) => {
    if (
      view.stockOnHand !== stock ||
      view.version !== version ||
      view.stockReserved !== baseline.stockReserved ||
      view.packageContent?.quantity !== baseline.packageContentQuantity ||
      view.packageContent?.unit !== baseline.packageContentUnit
    )
      throw new Error("An inventory adjustment changed the expected stock, reservation or pack");
  };

  await mustReject(
    () => send({ ...request, generation: "previous-rehearsal" }),
    "sync_generation_changed",
  );
  await mustReject(() => send({ ...request, actorUserId: Bun.randomUUIDv7() }), "forbidden");
  const received = await send(request);
  assertStock(received, startingStock + 1, baseline.version + 1);
  assertStock(await send(request), startingStock + 1, baseline.version + 1);
  await mustReject(
    () => send({ ...request, quantity: 2 }),
    "invalid_state",
    "Idempotency key belongs to another inventory request",
  );

  const count = {
    ...request,
    kind: "count",
    quantity: startingStock,
    reason: "Synthetic recovery count",
    idempotencyKey: Bun.randomUUIDv7(),
  };
  await mustReject(() => send(count), "version_conflict");
  await mustReject(
    () => send({ ...count, version: received.version, quantity: 0 }),
    "invalid_state",
    "Stock adjustment would consume reserved or unavailable units",
  );
  assertStock(
    await send({ ...count, version: received.version }),
    startingStock,
    baseline.version + 2,
  );
  // Run the ledger's deferred stamp without committing any of the rehearsal writes.
  await tx.execute(sql`set constraints stamp_stock_movement_ledger immediate`);
  const ledger = await tx
    .select({
      key: stockMovement.idempotencyKey,
      kind: stockMovement.kind,
      delta: stockMovement.quantityDelta,
      position: stockMovement.ledgerPosition,
    })
    .from(stockMovement)
    .where(
      and(
        eq(stockMovement.productId, product.id),
        inArray(stockMovement.idempotencyKey, [request.idempotencyKey, count.idempotencyKey]),
      ),
    );
  const deliveryRow = ledger.find((row) => row.key === request.idempotencyKey);
  const countRow = ledger.find((row) => row.key === count.idempotencyKey);
  if (
    ledger.length !== 2 ||
    deliveryRow?.kind !== "receive" ||
    deliveryRow.delta !== 1 ||
    countRow?.kind !== "count" ||
    countRow.delta !== -1
  )
    throw new Error("The restored inventory ledger does not match the two test adjustments");
  if (
    deliveryRow.position <= BigInt(head?.position ?? "0") ||
    countRow.position <= deliveryRow.position
  )
    throw new Error("The restored stock ledger did not assign ordered positions");

  return {
    status: "exercised" as const,
    staleGenerationRejected: true,
    otherAccountRejected: true,
    staleVersionRejected: true,
    movementReplayRecordedOnce: true,
    modifiedReplayRejected: true,
    countBelowReservedRejected: true,
    countPreservedPackAndReservations: true,
    orderedLedgerPositionsVerified: true,
  };
}
