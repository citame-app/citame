import { inventoryWarehouse, warehouseStock } from "@sob/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import { DomainError } from "../../errors";
import type { Tx } from "../../tx";

export const primaryWarehouse = { id: null, name: null, active: true, version: 0 } as const;

export async function lockActiveWarehouses(tx: Tx, ids: string[]) {
  if (ids.length === 0) return new Map<string, string>();
  const rows = await tx
    .select()
    .from(inventoryWarehouse)
    .where(inArray(inventoryWarehouse.id, ids))
    .orderBy(asc(inventoryWarehouse.id))
    .for("share");
  if (rows.length !== ids.length || rows.some((row) => !row.active))
    throw new DomainError("version_conflict", "Review the active warehouse before saving");
  return new Map(rows.map((row) => [row.id, row.name]));
}

// Callers hold the product lock before reading or changing a secondary balance.
export async function readWarehouseQuantity(tx: Tx, productId: string, warehouseId: string) {
  const [row] = await tx
    .select({ quantity: warehouseStock.quantity })
    .from(warehouseStock)
    .where(
      and(eq(warehouseStock.productId, productId), eq(warehouseStock.warehouseId, warehouseId)),
    );
  return row?.quantity ?? 0;
}

export async function writeWarehouseQuantity(
  tx: Tx,
  productId: string,
  warehouseId: string,
  quantity: number,
) {
  await tx
    .insert(warehouseStock)
    .values({ productId, warehouseId, quantity })
    .onConflictDoUpdate({
      target: [warehouseStock.warehouseId, warehouseStock.productId],
      set: { quantity },
    });
}
