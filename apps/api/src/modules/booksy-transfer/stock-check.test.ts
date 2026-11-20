import { expect, test } from "bun:test";
import { createProductSchema } from "@sob/contracts";
import { checkout, retailProduct, stockMovement, user } from "@sob/db";
import { createTestDatabase } from "@sob/db/testing";
import type { Principal } from "../../auth/principal";
import { createProduct } from "../inventory/service";
import { checkRestoredStock } from "./stock-check";

test("the PostgreSQL stock rehearsal handles an empty catalogue and rolls back a full-stock product", async () => {
  const database = await createTestDatabase("booksy_restored_stock");
  try {
    await database.reset();
    const { db } = database;
    const operator: Principal = {
      userId: Bun.randomUUIDv7(),
      role: "owner",
      name: "Synthetic stock probe",
      email: "stock-probe@example.invalid",
      staffId: null,
      clientId: null,
    };
    await db.insert(user).values({
      id: operator.userId,
      role: operator.role,
      name: operator.name,
      email: operator.email,
    });
    expect(await db.transaction((tx) => checkRestoredStock(tx, operator))).toEqual({
      status: "empty",
    });
    await createProduct(
      db,
      createProductSchema.parse({
        name: "Synthetic pack",
        sku: "RECOVERY-PACK",
        priceCents: 100,
        openingStock: 999999999,
        idempotencyKey: Bun.randomUUIDv7(),
      }),
      operator,
    );
    const productsBefore = await db.select().from(retailProduct);
    const movementsBefore = await db.select().from(stockMovement);
    const rollback = new Error("End stock rehearsal");
    await expect(
      db.transaction(async (tx) => {
        const proof = await checkRestoredStock(tx, operator);
        expect(proof).toMatchObject({
          status: "exercised",
          modifiedReplayRejected: true,
          countBelowReservedRejected: true,
          countPreservedPackAndReservations: true,
          orderedLedgerPositionsVerified: true,
        });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await db.select().from(retailProduct)).toEqual(productsBefore);
    expect(await db.select().from(stockMovement)).toEqual(movementsBefore);
    expect(await db.select().from(checkout)).toHaveLength(0);
  } finally {
    await database.close();
  }
});
