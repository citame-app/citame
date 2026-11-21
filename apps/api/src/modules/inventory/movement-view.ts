import type { stockMovement } from "@sob/db";

export function movementView(row: typeof stockMovement.$inferSelect, readCosts: boolean) {
  return {
    id: row.id,
    productId: row.productId,
    kind: row.kind,
    quantityDelta: row.quantityDelta,
    reason: row.reason,
    checkoutLineId: row.checkoutLineId,
    ...(row.receiptId ? { receiptId: row.receiptId } : {}),
    ...(row.warehouseId
      ? { warehouseId: row.warehouseId, warehouseName: row.warehouseName ?? undefined }
      : {}),
    ...(row.transferId ? { transferId: row.transferId } : {}),
    createdAt: row.createdAt.toISOString(),
    ...(readCosts ? { unitCostCents: row.unitCostCents } : {}),
  };
}
