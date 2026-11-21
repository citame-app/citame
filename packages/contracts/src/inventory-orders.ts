import { z } from "zod";
import { idempotencyKeySchema } from "./commerce";
import {
  idSchema,
  instantSchema,
  localDateSchema,
  pageInfoSchema,
  requiredTextSchema,
  syncGenerationSchema,
} from "./common";

export const MAX_PURCHASE_ORDER_LINES = 50;
const quantity = z.number().int().min(1).max(999999999);
const id = idSchema.transform((value) => value.toLowerCase());
export const purchaseOrderStatusSchema = z.enum([
  "draft",
  "ordered",
  "partially_received",
  "received",
  "cancelled",
]);
const revision = {
  generation: syncGenerationSchema,
  version: z.number().int().min(0).max(2147483646),
  idempotencyKey: idempotencyKeySchema,
};
export const purchaseOrderCommandSchema = z.discriminatedUnion("action", [
  z.strictObject({
    ...revision,
    action: z.literal("save"),
    supplierId: id,
    supplierReference: requiredTextSchema(100).nullable(),
    expectedOn: localDateSchema.nullable(),
    notes: requiredTextSchema(1000).nullable(),
    lines: z
      .array(z.strictObject({ productId: id, quantity }))
      .min(1)
      .max(MAX_PURCHASE_ORDER_LINES)
      .refine((lines) => new Set(lines.map((line) => line.productId)).size === lines.length),
  }),
  z.strictObject({
    ...revision,
    action: z.enum(["order", "cancel"]),
  }),
]);
export const purchaseOrderLinkSchema = z.strictObject({ id, version: revision.version.positive() });
const header = z.object({
  id: idSchema,
  number: z.number().int().positive(),
  status: purchaseOrderStatusSchema,
  version: z.number().int().positive(),
  supplierId: idSchema,
  supplierName: z.string(),
  supplierReference: z.string().nullable(),
  expectedOn: localDateSchema.nullable(),
  notes: z.string().nullable(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
  orderedAt: instantSchema.nullable(),
  closedAt: instantSchema.nullable(),
});
export const purchaseOrderSchema = header.extend({
  generation: syncGenerationSchema,
  lines: z.array(
    z.object({
      productId: idSchema,
      name: z.string(),
      sku: z.string(),
      quantity,
      receivedQuantity: z.number().int().min(0).max(999999999),
    }),
  ),
  receipts: z.array(
    z.object({ id: idSchema, number: z.number().int().positive(), receivedOn: localDateSchema }),
  ),
});
export const purchaseOrderQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(100).default(""),
  status: purchaseOrderStatusSchema.optional(),
});
export const purchaseOrderListSchema = z.object({
  orders: z.array(header),
  generation: syncGenerationSchema,
  pagination: pageInfoSchema,
});
export type PurchaseOrder = z.infer<typeof purchaseOrderSchema>;
export type PurchaseOrderSummary = z.infer<typeof header>;
export type PurchaseOrderCommand = z.infer<typeof purchaseOrderCommandSchema>;
export type PurchaseOrderQuery = z.infer<typeof purchaseOrderQuerySchema>;
