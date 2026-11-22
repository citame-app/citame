import {
  type CreateProductInput,
  type InventoryBrandLogoInput,
  type InventoryClassificationInput,
  type InventoryClassificationReorder,
  inventoryBrandLogoResultSchema,
  inventoryClassificationListSchema,
  inventoryClassificationOrderResultSchema,
  inventoryClassificationSchema,
  inventoryFacetsSchema,
  inventoryReportSchema,
  type ProductPhotoInput,
  type ProductQuery,
  type PurchaseOrderCommand,
  type PurchaseOrderQuery,
  productListSchema,
  productPhotoVersionSchema,
  productSchema,
  purchaseOrderListSchema,
  purchaseOrderSchema,
  reviewedInventoryMovementsSchema,
  reviewedInventoryProductSchema,
  reviewedStockReceiptListSchema,
  reviewedStockReceiptSchema,
  reviewedSupplierSchema,
  type StockLedgerFilters,
  type StockLedgerQuery,
  type StockMovementInput,
  type StockReceiptInput,
  type StockReceiptQuery,
  type StockReturnInput,
  type StockTransferInput,
  type SupplierInput,
  type SupplierQuery,
  stockLedgerSchema,
  stockReceiptSchema,
  stockTransferSchema,
  supplierListSchema,
  supplierSchema,
  type UpdateProductInput,
  type WarehouseInput,
  type WarehouseStockQuery,
  warehouseListSchema,
  warehouseSchema,
  warehouseStockSchema,
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
    classifications: (signal?: AbortSignal) =>
      client.get("/admin/inventory/classifications", inventoryClassificationListSchema, { signal }),
    saveBrandLogo: (id: string, body: InventoryBrandLogoInput) =>
      client.put(
        `/admin/inventory/classifications/${id}/logo`,
        body,
        inventoryBrandLogoResultSchema,
      ),
    reorderClassifications: (body: InventoryClassificationReorder) =>
      client.put(
        "/admin/inventory/classifications/order",
        body,
        inventoryClassificationOrderResultSchema,
      ),
    saveClassification: (id: string, body: InventoryClassificationInput) =>
      client.put(`/admin/inventory/classifications/${id}`, body, inventoryClassificationSchema),
    warehouses: () => client.get("/admin/inventory/warehouses", warehouseListSchema),
    warehouseStock: (
      query: Partial<WarehouseStockQuery> & Pick<WarehouseStockQuery, "warehouseId">,
    ) => client.get("/admin/inventory/warehouse-stock", warehouseStockSchema, { query }),
    saveWarehouse: (id: string, body: WarehouseInput) =>
      client.put(`/admin/inventory/warehouses/${id}`, body, warehouseSchema),
    transfer: (id: string) => client.get(`/admin/inventory/transfers/${id}`, stockTransferSchema),
    saveTransfer: (id: string, body: StockTransferInput) =>
      client.put(`/admin/inventory/transfers/${id}`, body, stockTransferSchema),
    orders: (query: Partial<PurchaseOrderQuery> = {}) =>
      client.get("/admin/inventory/orders", purchaseOrderListSchema, { query }),
    order: (id: string) => client.get(`/admin/inventory/orders/${id}`, purchaseOrderSchema),
    saveOrder: (id: string, body: PurchaseOrderCommand) =>
      client.put(`/admin/inventory/orders/${id}`, body, purchaseOrderSchema),
    suppliers: ({ active, ...query }: Partial<SupplierQuery> = {}) =>
      client.get("/admin/inventory/suppliers", supplierListSchema, {
        query: { ...query, active: active === undefined ? undefined : String(active) },
      }),
    supplier: (id: string) =>
      client.get(`/admin/inventory/suppliers/${id}`, reviewedSupplierSchema),
    saveSupplier: (id: string, body: SupplierInput) =>
      client.put(`/admin/inventory/suppliers/${id}`, body, supplierSchema),
    receipts: (query: Partial<StockReceiptQuery> = {}) =>
      client.get("/admin/inventory/receipts", reviewedStockReceiptListSchema, { query }),
    receipt: (id: string) =>
      client.get(`/admin/inventory/receipts/${id}`, reviewedStockReceiptSchema),
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
