import {
  type CreateProductInput,
  productListSchema,
  productSchema,
  type StockMovementInput,
  type StockReturnInput,
  stockMovementListSchema,
  type UpdateProductInput,
} from "@sob/contracts";
import type { ApiClient } from "./client";
export function inventoryEndpoints(client: ApiClient) {
  return {
    list: (
      query: {
        search?: string;
        active?: "active" | "inactive" | "all";
        lowStock?: boolean;
        page?: number;
        pageSize?: number;
      } = {},
    ) =>
      client.get("/admin/inventory/products", productListSchema, {
        query: {
          ...query,
          lowStock: query.lowStock === undefined ? undefined : String(query.lowStock),
        },
      }),
    create: (body: CreateProductInput) =>
      client.post("/admin/inventory/products", body, productSchema),
    update: (id: string, body: UpdateProductInput) =>
      client.patch(`/admin/inventory/products/${id}`, body, productSchema),
    move: (id: string, body: StockMovementInput) =>
      client.post(`/admin/inventory/products/${id}/movements`, body, productSchema),
    movements: (id: string, page = 1) =>
      client.get(`/admin/inventory/products/${id}/movements`, stockMovementListSchema, {
        query: { page },
      }),
    returnStock: (body: StockReturnInput) =>
      client.post("/admin/inventory/returns", body, productSchema),
  };
}
