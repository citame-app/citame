import { z } from "zod";
import { clientPhotoUploadSchema } from "./client-photos";
import { idempotencyKeySchema, moneyCentsSchema } from "./commerce";
import { idSchema, instantSchema, pageInfoSchema, syncGenerationSchema } from "./common";

const quantity = z.number().int().min(0).max(999999999);
const recordedPackageContent = z.strictObject({
  quantity: z
    .string()
    .regex(/^\d{1,9}(?:\.\d{1,3})?$/)
    .refine((value) => Number(value) > 0),
  unit: z
    .string()
    .trim()
    .min(1)
    .max(20)
    .refine((value) => !value.includes("\u0000")),
});
export const packageContentSchema = recordedPackageContent.extend({
  quantity: z
    .string()
    .trim()
    .regex(/^\d{1,9}(?:[.,]\d{1,3})?$/)
    .transform((value) => String(Number(value.replace(",", "."))))
    .pipe(recordedPackageContent.shape.quantity),
});
export type PackageContent = z.infer<typeof packageContentSchema>;
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
  sku: sku.optional(),
  barcode: barcode.optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  category: z.string().trim().min(1).max(100).nullable().optional(),
  brand: z.string().trim().min(1).max(100).nullable().optional(),
  resellable: z.boolean().optional(),
  targetStock: quantity.nullable().optional(),
  priceCents: moneyCentsSchema,
  costCents: moneyCentsSchema.nullable().optional(),
  taxBasisPoints: z.number().int().min(0).max(10000).default(0),
  unitLabel: z.string().trim().min(1).max(20).default("unit"),
  packageContent: packageContentSchema.nullable().optional(),
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
export const updatePackageContentSchema = z.strictObject({
  version: z.number().int().positive(),
  packageContent: packageContentSchema.nullable(),
});
export const productFiltersSchema = z.object({
  search: z.string().trim().max(100).default(""),
  category: z.string().trim().max(100).optional(),
  brand: z.string().trim().max(100).optional(),
  resellable: z.stringbool().optional(),
  active: z.enum(["active", "inactive", "all"]).default("active"),
  lowStock: z.stringbool().default(false),
});
export const productSortSchema = z.enum(["name_asc", "name_desc", "updated_desc", "stock_asc"]);
export type ProductSort = z.infer<typeof productSortSchema>;
export const productExportQuerySchema = productFiltersSchema.extend({
  sort: productSortSchema.default("name_asc"),
});
export const productQuerySchema = productExportQuerySchema.extend({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type ProductFilters = z.infer<typeof productFiltersSchema>;
export type ProductExportQuery = z.infer<typeof productExportQuerySchema>;

export const inventoryReportSchema = z.object({
  products: z.number().int().nonnegative(),
  onHand: z.number().int().nonnegative(),
  reserved: z.number().int().nonnegative(),
  lowStockProducts: z.number().int().nonnegative(),
  valuation: z
    .object({
      currency: z.literal("EUR"),
      knownCostCents: z.string().regex(/^\d+$/),
      productsMissingCost: z.number().int().nonnegative(),
    })
    .optional(),
});
const movementFields = {
  quantity,
  reason: z
    .string()
    .trim()
    .min(3)
    .max(300)
    .refine((value) => !value.includes("\u0000")),
  version: z.number().int().positive(),
  idempotencyKey: idempotencyKeySchema,
  generation: syncGenerationSchema,
  actorUserId: z.string().min(1).max(200).optional(),
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
    actorUserId: z.string().min(1).max(200).optional(),
    generation: syncGenerationSchema.optional(),
    quantity: quantity.positive(),
    reason: z.string().trim().min(3).max(300),
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();
export const productSchema = z.object({
  id: idSchema,
  name: z.string(),
  photoVersion: idSchema.optional(),
  sku: z.string(),
  barcode: z.string().nullable(),
  description: z.string().nullable(),
  category: z.string().nullable().optional(),
  brand: z.string().nullable().optional(),
  resellable: z.boolean().optional(),
  targetStock: quantity.nullable().optional(),
  priceCents: moneyCentsSchema,
  currency: z.literal("EUR"),
  costCents: moneyCentsSchema.nullable().optional(),
  taxBasisPoints: z.number().int(),
  unitLabel: z.string(),
  packageContent: recordedPackageContent.nullable().optional(),
  canManage: z.boolean().optional(),
  inventoryGeneration: syncGenerationSchema.optional(),
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
export const productPhotoVersionSchema = z.strictObject({ version: idSchema.nullable() });
export const productPhotoInputSchema = productPhotoVersionSchema.extend({
  imageBase64: clientPhotoUploadSchema.shape.imageBase64.nullable(),
});
export type ProductPhotoInput = z.infer<typeof productPhotoInputSchema>;
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
  receiptId: idSchema.optional(),
  createdAt: instantSchema,
});
export const stockMovementListSchema = z.object({
  movements: z.array(stockMovementSchema),
  pagination: pageInfoSchema,
  inventoryGeneration: syncGenerationSchema.optional(),
});
export const reviewedInventoryProductSchema = productSchema.extend({
  inventoryGeneration: syncGenerationSchema,
});
export const reviewedInventoryMovementsSchema = stockMovementListSchema.extend({
  inventoryGeneration: syncGenerationSchema,
});
export type Product = z.infer<typeof productSchema>;
export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
export type ProductQuery = z.infer<typeof productQuerySchema>;
export type StockMovementInput = z.infer<typeof stockMovementInputSchema>;
export type StockReturnInput = z.infer<typeof stockReturnSchema>;

export const inventoryFacetsSchema = z.object({
  categories: z.array(z.string()),
  brands: z.array(z.string()),
});
const stockLedgerAnchorSchema = z
  .templateLiteral([syncGenerationSchema, "~", z.string().regex(/^(?:0|[1-9][0-9]{0,18})$/)])
  .refine((value) => BigInt(value.slice(value.indexOf("~") + 1)) <= 9_223_372_036_854_775_807n);
export const stockLedgerFiltersSchema = z.object({
  kind: z.enum(["opening", "receive", "consume", "count", "sale", "return"]).optional(),
  search: z.string().trim().max(100).default(""),
  anchor: stockLedgerAnchorSchema.optional(),
});
export type StockLedgerFilters = z.infer<typeof stockLedgerFiltersSchema>;
export const stockLedgerQuerySchema = stockLedgerFiltersSchema.extend({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export const stockLedgerSchema = z.object({
  movements: z.array(stockMovementSchema.extend({ productName: z.string(), sku: z.string() })),
  pagination: pageInfoSchema,
  anchor: stockLedgerAnchorSchema.optional(),
  hasNewer: z.boolean().optional(),
});
export type StockLedgerQuery = z.infer<typeof stockLedgerQuerySchema>;
