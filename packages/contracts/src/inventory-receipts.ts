import { z } from "zod";
import { idempotencyKeySchema, moneyCentsSchema } from "./commerce";
import {
  idSchema,
  instantSchema,
  localDateSchema,
  pageInfoSchema,
  syncGenerationSchema,
} from "./common";

const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !value.includes("\u0000"));
const version = z.number().int().min(0).max(2147483647);
const supplierFields = {
  name: text(160),
  email: z.email().max(254).nullable(),
  phone: text(50).nullable(),
  taxId: text(50).nullable(),
  notes: text(1000).nullable(),
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
  invoiceReference: text(100).nullable(),
  notes: text(1000).nullable(),
  idempotencyKey: idempotencyKeySchema,
  actorUserId: z.string().min(1).max(200),
  generation: syncGenerationSchema,
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
export type Supplier = z.infer<typeof supplierSchema>;
export type SupplierInput = z.infer<typeof supplierInputSchema>;
export type SupplierQuery = z.infer<typeof supplierQuerySchema>;
export type StockReceipt = z.infer<typeof stockReceiptSchema>;
export type StockReceiptInput = z.infer<typeof stockReceiptInputSchema>;
export type StockReceiptQuery = z.infer<typeof stockReceiptQuerySchema>;
