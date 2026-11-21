import {
  type CreateProductInput,
  inventoryFacetsSchema,
  inventoryReportSchema,
  type ProductPhotoInput,
  type ProductQuery,
  productListSchema,
  productPhotoVersionSchema,
  productSchema,
  reviewedInventoryMovementsSchema,
  reviewedInventoryProductSchema,
  type StockLedgerFilters,
  type StockLedgerQuery,
  type StockMovementInput,
  type StockReceiptInput,
  type StockReceiptQuery,
  type StockReturnInput,
  stockLedgerSchema,
  stockReceiptListSchema,
  stockReceiptSchema,
  type SupplierInput,
  type SupplierQuery,
  supplierListSchema,
  supplierSchema,
  type UpdateProductInput,
} from "@sob/contracts";
import type { ApiClient } from "./client";

const inventoryParams = ({ resellable, lowStock, ...query }: Partial<ProductQuery>) => ({
  ...query,
  resellable: resellable === undefined ? undefined : String(resellable),
  lowStock: lowStock === undefined ? undefined : String(lowStock),
});

function inventoryDownloadHref(
  path: "products" | "movements",
  filters: Record<string, string | number | undefined>,
) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters))
    if (value !== undefined) query.set(key, String(value));
  return `/api/admin/inventory/${path}/export${query.size ? `?${query}` : ""}`;
}

export const inventoryExportHref = (filters: Partial<ProductQuery>) =>
  inventoryDownloadHref("products", inventoryParams(filters));

export const stockLedgerExportHref = (filters: Partial<StockLedgerFilters>) =>
  inventoryDownloadHref("movements", filters);

export function inventoryEndpoints(client: ApiClient) {
  return {
    suppliers: ({ active, ...query }: Partial<SupplierQuery> = {}) =>
      client.get("/admin/inventory/suppliers", supplierListSchema, {
        query: { ...query, active: active === undefined ? undefined : String(active) },
      }),
    supplier: (id: string) => client.get(`/admin/inventory/suppliers/${id}`, supplierSchema),
    saveSupplier: (id: string, body: SupplierInput) =>
      client.put(`/admin/inventory/suppliers/${id}`, body, supplierSchema),
    receipts: (query: Partial<StockReceiptQuery> = {}) =>
      client.get("/admin/inventory/receipts", stockReceiptListSchema, { query }),
    receipt: (id: string) => client.get(`/admin/inventory/receipts/${id}`, stockReceiptSchema),
    receive: (body: StockReceiptInput) =>
      client.post("/admin/inventory/receipts", body, stockReceiptSchema),
    facets: () => client.get("/admin/inventory/facets", inventoryFacetsSchema),
    ledger: (query: Partial<StockLedgerQuery> = {}, signal?: AbortSignal) =>
      client.get("/admin/inventory/movements", stockLedgerSchema, { query, signal }),
    report: (filters: Partial<ProductQuery>) =>
      client.get("/admin/inventory/products/report", inventoryReportSchema, {
        query: inventoryParams(filters),
      }),
    list: (query: Partial<ProductQuery> = {}) =>
      client.get("/admin/inventory/products", productListSchema, {
        query: inventoryParams(query),
      }),
    get: (id: string) =>
      client.get(`/admin/inventory/products/${id}`, reviewedInventoryProductSchema),
    savePhoto: (id: string, body: ProductPhotoInput) =>
      client.put(`/admin/inventory/products/${id}/photo`, body, productPhotoVersionSchema),
    create: (body: CreateProductInput) =>
      client.post("/admin/inventory/products", body, reviewedInventoryProductSchema),
    update: (id: string, body: UpdateProductInput) =>
      client.patch(`/admin/inventory/products/${id}`, body, reviewedInventoryProductSchema),
    move: (id: string, body: StockMovementInput) =>
      client.post(
        `/admin/inventory/products/${id}/movements`,
        body,
        reviewedInventoryProductSchema,
      ),
    movements: (id: string, page = 1) =>
      client.get(`/admin/inventory/products/${id}/movements`, reviewedInventoryMovementsSchema, {
        query: { page },
      }),
    returnStock: (body: StockReturnInput) =>
      client.post("/admin/inventory/returns", body, productSchema),
  };
}
