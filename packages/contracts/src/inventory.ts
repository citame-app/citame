import { z } from "zod";
import { idempotencyKeySchema, moneyCentsSchema } from "./commerce";
import { idSchema, instantSchema, pageInfoSchema } from "./common";

const quantity = z.number().int().min(0).max(999999999);
const sku = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9][A-Z0-9._/-]*$/));
const barcode = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9._/-]+$/)
  .nullable();
const fields = {
  name: z.string().trim().min(1).max(160),
  sku,
  barcode: barcode.optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  priceCents: moneyCentsSchema,
  costCents: moneyCentsSchema.nullable().optional(),
  taxBasisPoints: z.number().int().min(0).max(10000).default(0),
  unitLabel: z.string().trim().min(1).max(20).default("unit"),
  storageLocation: z.string().trim().max(80).nullable().optional(),
  lowStockThreshold: quantity.default(0),
};
export const createProductSchema = z
  .object({ ...fields, openingStock: quantity.default(0), idempotencyKey: idempotencyKeySchema })
  .strict();
export const updateProductSchema = z
  .object({
    ...fields,
    taxBasisPoints: z.number().int().min(0).max(10000),
    unitLabel: z.string().trim().min(1).max(20),
    lowStockThreshold: quantity,
    active: z.boolean(),
  })
  .partial()
  .extend({ version: z.number().int().positive() })
  .strict()
  .refine(
    (value) => Object.keys(value).some((key) => key !== "version"),
    "Provide a product change",
  );
export const productQuerySchema = z.object({
  search: z.string().trim().max(100).default(""),
  active: z.enum(["active", "inactive", "all"]).default("active"),
  lowStock: z.stringbool().default(false),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
const movementFields = {
  quantity,
  reason: z.string().trim().min(3).max(300),
  version: z.number().int().positive(),
  idempotencyKey: idempotencyKeySchema,
};
export const stockMovementInputSchema = z.discriminatedUnion("kind", [
  z
    .object({ ...movementFields, kind: z.literal("receive"), quantity: quantity.positive() })
    .strict(),
  z
    .object({ ...movementFields, kind: z.literal("consume"), quantity: quantity.positive() })
    .strict(),
  z.object({ ...movementFields, kind: z.literal("count") }).strict(),
]);
export const stockReturnSchema = z
  .object({
    checkoutLineId: idSchema,
    quantity: quantity.positive(),
    reason: z.string().trim().min(3).max(300),
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();
export const productSchema = z.object({
  id: idSchema,
  name: z.string(),
  sku: z.string(),
  barcode: z.string().nullable(),
  description: z.string().nullable(),
  priceCents: moneyCentsSchema,
  currency: z.literal("EUR"),
  costCents: moneyCentsSchema.nullable().optional(),
  taxBasisPoints: z.number().int(),
  unitLabel: z.string(),
  storageLocation: z.string().nullable(),
  active: z.boolean(),
  stockOnHand: quantity,
  stockReserved: quantity,
  available: quantity,
  lowStockThreshold: quantity,
  lowStock: z.boolean(),
  version: z.number().int().positive(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
});
export const productListSchema = z.object({
  products: z.array(productSchema),
  pagination: pageInfoSchema,
});
export const stockMovementSchema = z.object({
  id: idSchema,
  productId: idSchema,
  kind: z.enum(["opening", "receive", "consume", "count", "sale", "return"]),
  quantityDelta: z.number().int(),
  reason: z.string(),
  unitCostCents: moneyCentsSchema.nullable().optional(),
  checkoutLineId: idSchema.nullable(),
  createdAt: instantSchema,
});
export const stockMovementListSchema = z.object({
  movements: z.array(stockMovementSchema),
  pagination: pageInfoSchema,
});
export type Product = z.infer<typeof productSchema>;
export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
export type ProductQuery = z.infer<typeof productQuerySchema>;
export type StockMovementInput = z.infer<typeof stockMovementInputSchema>;
export type StockReturnInput = z.infer<typeof stockReturnSchema>;
