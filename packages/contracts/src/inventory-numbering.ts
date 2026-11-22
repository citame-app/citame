import { z } from "zod";
import { syncGenerationSchema } from "./common";

export const INVENTORY_NUMBER_MAX = 2147483647;
export const inventoryNumberingSeriesSchema = z.enum(["orders", "receipts"]);
export type InventoryNumberingSeries = z.infer<typeof inventoryNumberingSeriesSchema>;
const documentNumber = z.number().int().min(1).max(INVENTORY_NUMBER_MAX);
export const inventoryNumberingStateSchema = z.object({
  nextNumber: documentNumber.nullable(),
  lastIssuedNumber: documentNumber.nullable(),
});
export const inventoryNumberingSnapshotSchema = z.object({
  generation: syncGenerationSchema,
  orders: inventoryNumberingStateSchema,
  receipts: inventoryNumberingStateSchema,
});
export type InventoryNumberingSnapshot = z.infer<typeof inventoryNumberingSnapshotSchema>;
export const advanceInventoryNumberingSchema = z.strictObject({
  generation: syncGenerationSchema,
  expectedNextNumber: documentNumber,
  nextNumber: documentNumber,
});
export type AdvanceInventoryNumbering = z.infer<typeof advanceInventoryNumberingSchema>;
