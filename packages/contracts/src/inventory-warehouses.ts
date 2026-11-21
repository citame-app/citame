import { z } from "zod";
import {
  idSchema,
  instantSchema,
  pageInfoSchema,
  requiredTextSchema,
  syncGenerationSchema,
} from "./common";

const warehouseLocation = idSchema.transform((id) => id.toLowerCase()).nullable();
const warehouseVersion = z.number().int().min(0).max(2147483646);
const units = z.number().int().min(0).max(999999999);

export const warehouseSchema = z.object({
  id: warehouseLocation,
  name: z.string().nullable(),
  active: z.boolean(),
  version: warehouseVersion,
});

export const warehouseInputSchema = z.strictObject({
  name: requiredTextSchema(100),
  active: z.boolean(),
  version: warehouseVersion,
  generation: syncGenerationSchema,
});

export const warehouseListSchema = z.object({
  warehouses: z.array(warehouseSchema),
  generation: syncGenerationSchema,
});

export const warehouseStockQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(100).default(""),
  availableOnly: z.literal("1").optional(),
  productId: idSchema.transform((id) => id.toLowerCase()).optional(),
  warehouseId: z.union([z.literal("main"), idSchema.transform((id) => id.toLowerCase())]),
});

export const warehouseStockSchema = z.object({
  warehouse: warehouseSchema,
  products: z.array(
    z.object({
      productId: idSchema,
      sku: z.string(),
      name: z.string(),
      active: z.boolean(),
      version: warehouseVersion.positive(),
      onHand: units,
      reserved: units,
    }),
  ),
  generation: syncGenerationSchema,
  pagination: pageInfoSchema,
});

const stockTransferLine = z.strictObject({
  productId: idSchema.transform((id) => id.toLowerCase()),
  quantity: units.positive(),
  version: warehouseVersion.positive(),
});

export const MAX_STOCK_TRANSFER_LINES = 50;
export const stockTransferInputSchema = z
  .strictObject({
    sourceId: warehouseLocation,
    destinationId: warehouseLocation,
    reason: requiredTextSchema(300),
    generation: syncGenerationSchema,
    lines: z
      .array(stockTransferLine)
      .min(1)
      .max(MAX_STOCK_TRANSFER_LINES)
      .refine((lines) => new Set(lines.map((line) => line.productId)).size === lines.length),
  })
  .refine((input) => input.sourceId !== input.destinationId, { path: ["destinationId"] });

export const stockTransferSchema = z.object({
  id: idSchema,
  sourceId: warehouseLocation,
  sourceName: z.string().nullable(),
  destinationId: warehouseLocation,
  destinationName: z.string().nullable(),
  reason: z.string(),
  lines: z.array(
    z.object({
      productId: idSchema,
      sku: z.string(),
      name: z.string(),
      quantity: units.positive(),
    }),
  ),
  createdAt: instantSchema,
});

export type Warehouse = z.infer<typeof warehouseSchema>;
export type WarehouseStock = z.infer<typeof warehouseStockSchema>;
export type WarehouseInput = z.infer<typeof warehouseInputSchema>;
export type WarehouseStockQuery = z.infer<typeof warehouseStockQuerySchema>;
export type StockTransferInput = z.infer<typeof stockTransferInputSchema>;
export type StockTransfer = z.infer<typeof stockTransferSchema>;
