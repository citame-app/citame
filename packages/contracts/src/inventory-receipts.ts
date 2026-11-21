import { z } from "zod";
import { idempotencyKeySchema, moneyCentsSchema } from "./commerce";
import {
  idSchema,
  instantSchema,
  localDateSchema,
  pageInfoSchema,
  requiredTextSchema,
  syncGenerationSchema,
} from "./common";
import { purchaseOrderLinkSchema } from "./inventory-orders";

const version = z.number().int().min(0).max(2147483647);
const supplierFields = {
  name: requiredTextSchema(160),
  email: z.email().max(254).nullable(),
  phone: requiredTextSchema(50).nullable(),
  taxId: requiredTextSchema(50).nullable(),
  notes: requiredTextSchema(1000).nullable(),
  active: z.boolean(),
};
export const supplierInputSchema = z.strictObject({
  ...supplierFields,
  version,
  generation: syncGenerationSchema,
});
export const supplierSchema = z.object({
  ...supplierFields,
  id: idSchema,
  version: version.positive(),
});
export const reviewedSupplierSchema = supplierSchema.extend({ generation: syncGenerationSchema });
const page = {
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
};
export const supplierQuerySchema = z.object({
  ...page,
  search: z.string().trim().max(100).default(""),
  active: z.stringbool().optional(),
});
export const supplierListSchema = z.object({
  suppliers: z.array(supplierSchema),
  pagination: pageInfoSchema,
  generation: syncGenerationSchema,
});

const quantity = z.number().int().min(1).max(999999999);
const receiptLineSchema = z.strictObject({
  productId: idSchema.transform((value) => value.toLowerCase()),
  quantity,
  version: version.positive(),
});
export const MAX_STOCK_RECEIPT_LINES = 50;
export const stockReceiptInputSchema = z.strictObject({
  receivedOn: localDateSchema,
  supplierId: idSchema.transform((value) => value.toLowerCase()).nullable(),
  invoiceReference: requiredTextSchema(100).nullable(),
  notes: requiredTextSchema(1000).nullable(),
  idempotencyKey: idempotencyKeySchema,
  actorUserId: z.string().min(1).max(200),
  generation: syncGenerationSchema,
  purchaseOrder: purchaseOrderLinkSchema.optional(),
  lines: z
    .array(receiptLineSchema)
    .min(1)
    .max(MAX_STOCK_RECEIPT_LINES)
    .refine(
      (lines) => new Set(lines.map((line) => line.productId)).size === lines.length,
      "Each product may appear once per receipt",
    ),
});
const receiptHeader = z.object({
  id: idSchema,
  number: z.number().int().positive(),
  receivedOn: localDateSchema,
  supplierId: idSchema.nullable(),
  supplierName: z.string().nullable(),
  purchaseOrderId: idSchema.optional(),
  invoiceReference: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: instantSchema,
  lineCount: z.number().int().positive(),
});
export const stockReceiptSchema = receiptHeader.extend({
  lines: z.array(
    z.object({
      productId: idSchema,
      name: z.string(),
      sku: z.string(),
      quantity,
      unitCostCents: moneyCentsSchema.nullable().optional(),
    }),
  ),
});
export const stockReceiptQuerySchema = z.object(page);
export const stockReceiptListSchema = z.object({
  receipts: z.array(receiptHeader),
  pagination: pageInfoSchema,
});
export const reviewedStockReceiptSchema = stockReceiptSchema.extend({
  generation: syncGenerationSchema,
});
export const reviewedStockReceiptListSchema = stockReceiptListSchema.extend({
  generation: syncGenerationSchema,
});
export type Supplier = z.infer<typeof supplierSchema>;
export type SupplierInput = z.infer<typeof supplierInputSchema>;
export type SupplierQuery = z.infer<typeof supplierQuerySchema>;
export type StockReceipt = z.infer<typeof stockReceiptSchema>;
export type StockReceiptInput = z.infer<typeof stockReceiptInputSchema>;
export type StockReceiptQuery = z.infer<typeof stockReceiptQuerySchema>;
