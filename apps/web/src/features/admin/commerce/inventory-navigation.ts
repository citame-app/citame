import { idSchema, type PurchaseOrderQuery, purchaseOrderStatusSchema } from "@sob/contracts";

export const inventoryTabs = [
  "products",
  "movements",
  "stock",
  "receipts",
  "suppliers",
  "orders",
] as const;
export type InventoryTab = (typeof inventoryTabs)[number];
export type SupplierStatus = "all" | "active" | "inactive";
export type InventoryNavigation = {
  inventoryTab?: InventoryTab;
  receipt?: string;
  order?: string;
  orderSearch?: string;
  orderStatus?: PurchaseOrderQuery["status"];
  inventoryPage?: number;
  supplierSearch?: string;
  supplierStatus?: SupplierStatus;
};

export function parseInventoryNavigation(search: Record<string, unknown>): InventoryNavigation {
  const tab = inventoryTabs.find((value) => value === search.inventoryTab);
  const order = idSchema.safeParse(search.order);
  const orderStatus = purchaseOrderStatusSchema.safeParse(search.orderStatus);
  const orderSearch =
    typeof search.orderSearch === "string" ? search.orderSearch.slice(0, 100) : undefined;
  const receipt = idSchema.safeParse(search.receipt);
  const page =
    typeof search.inventoryPage === "number" &&
    Number.isInteger(search.inventoryPage) &&
    search.inventoryPage > 1 &&
    search.inventoryPage <= 100000
      ? search.inventoryPage
      : undefined;
  const term =
    typeof search.supplierSearch === "string" ? search.supplierSearch.slice(0, 100) : undefined;
  const status =
    search.supplierStatus === "active" || search.supplierStatus === "inactive"
      ? search.supplierStatus
      : undefined;
  return {
    ...(tab && tab !== "products" ? { inventoryTab: tab } : {}),
    ...(tab === "receipts" && receipt.success ? { receipt: receipt.data } : {}),
    ...(tab === "orders" && order.success ? { order: order.data } : {}),
    ...(tab === "orders" && orderSearch ? { orderSearch } : {}),
    ...(tab === "orders" && orderStatus.success ? { orderStatus: orderStatus.data } : {}),
    ...((tab === "receipts" || tab === "suppliers" || tab === "orders") && page
      ? { inventoryPage: page }
      : {}),
    ...(tab === "suppliers" && term ? { supplierSearch: term } : {}),
    ...(tab === "suppliers" && status ? { supplierStatus: status } : {}),
  };
}
