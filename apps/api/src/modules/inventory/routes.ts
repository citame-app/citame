import {
  createProductSchema,
  idSchema,
  productExportQuerySchema,
  productFiltersSchema,
  productPhotoInputSchema,
  productQuerySchema,
  purchaseOrderCommandSchema,
  purchaseOrderQuerySchema,
  stockLedgerFiltersSchema,
  stockLedgerQuerySchema,
  stockMovementInputSchema,
  stockReceiptInputSchema,
  stockReceiptQuerySchema,
  stockReturnSchema,
  stockTransferInputSchema,
  supplierInputSchema,
  supplierQuerySchema,
  updatePackageContentSchema,
  updateProductSchema,
  warehouseInputSchema,
  warehouseStockQuerySchema,
} from "@sob/contracts";
import { Hono } from "hono";
import type { AppDeps } from "../../app";
import { requirePermission } from "../../auth/policy";
import type { AppEnv } from "../../auth/principal";
import { parseOrThrow, readJson } from "../../http";
import { exportStockLedger, inventoryFacets, stockLedger } from "./ledger";
import { getPurchaseOrder, listPurchaseOrders, writePurchaseOrder } from "./orders";
import { readProductPhoto, saveProductPhoto } from "./photo";
import {
  getStockReceipt,
  getSupplier,
  listStockReceipts,
  listSuppliers,
  receiveStockDocument,
  saveSupplier,
} from "./receipts";
import { exportInventory, inventoryReport } from "./report";
import {
  createProduct,
  getProduct,
  getStockAdjustment,
  listMovements,
  listProducts,
  moveStock,
  returnStock,
  updateProduct,
} from "./service";
import {
  getStockTransfer,
  listWarehouses,
  saveWarehouse,
  transferStock,
  warehouseInventory,
} from "./warehouses";

export function inventoryRoutes(deps: AppDeps) {
  const generation = deps.config.syncReplicaGeneration;
  return new Hono<AppEnv>()
    .use("*", async (c, next) => {
      requirePermission(c.get("principal"), "readInventory");
      if (c.req.method !== "GET" && c.req.method !== "HEAD")
        requirePermission(c.get("principal"), "writeInventory");
      await next();
    })
    .get("/warehouses", async (c) =>
      c.json(await listWarehouses(deps.db, c.get("principal"), generation), 200, {
        "Cache-Control": "private, no-store",
      }),
    )
    .get("/warehouse-stock", async (c) =>
      c.json(
        await warehouseInventory(
          deps.db,
          parseOrThrow(warehouseStockQuerySchema, c.req.query()),
          c.get("principal"),
          generation,
        ),
        200,
        { "Cache-Control": "private, no-store" },
      ),
    )
    .put("/warehouses/:id", async (c) =>
      c.json(
        await saveWarehouse(
          deps.db,
          parseOrThrow(idSchema, c.req.param("id")).toLowerCase(),
          parseOrThrow(warehouseInputSchema, await readJson(c)),
          c.get("principal"),
          generation,
        ),
      ),
    )
    .get("/transfers/:id", async (c) =>
      c.json(
        await getStockTransfer(
          deps.db,
          parseOrThrow(idSchema, c.req.param("id")).toLowerCase(),
          c.get("principal"),
        ),
        200,
        { "Cache-Control": "private, no-store" },
      ),
    )
    .put("/transfers/:id", async (c) =>
      c.json(
        await transferStock(
          deps.db,
          parseOrThrow(idSchema, c.req.param("id")).toLowerCase(),
          parseOrThrow(stockTransferInputSchema, await readJson(c)),
          c.get("principal"),
          generation,
        ),
      ),
    )
    .get("/stock-adjustments/:id", async (c) =>
      c.json(
        await getStockAdjustment(
          deps.db,
          parseOrThrow(idSchema, c.req.param("id")).toLowerCase(),
          c.get("principal"),
        ),
        200,
        { "Cache-Control": "private, no-store" },
      ),
    )
    .get("/facets", async (c) => c.json(await inventoryFacets(deps.db, c.get("principal"))))
    .get("/orders", async (c) =>
      c.json(
        await listPurchaseOrders(
          deps.db,
          parseOrThrow(purchaseOrderQuerySchema, c.req.query()),
          c.get("principal"),
          generation,
        ),
        200,
        { "Cache-Control": "private, no-store" },
      ),
    )
    .get("/orders/:id", async (c) =>
      c.json(
        await getPurchaseOrder(
          deps.db,
          parseOrThrow(idSchema, c.req.param("id")).toLowerCase(),
          c.get("principal"),
          generation,
        ),
        200,
        { "Cache-Control": "private, no-store" },
      ),
    )
    .put("/orders/:id", async (c) =>
      c.json(
        await writePurchaseOrder(
          deps.db,
          parseOrThrow(idSchema, c.req.param("id")).toLowerCase(),
          parseOrThrow(purchaseOrderCommandSchema, await readJson(c)),
          c.get("principal"),
          generation,
        ),
        200,
        { "Cache-Control": "private, no-store" },
      ),
    )
    .get("/suppliers", async (c) =>
      c.json(
        await listSuppliers(
          deps.db,
          parseOrThrow(supplierQuerySchema, c.req.query()),
          c.get("principal"),
          generation,
        ),
        200,
        { "Cache-Control": "private, no-store" },
      ),
    )
    .get("/suppliers/:id", async (c) =>
      c.json(
        {
          ...(await getSupplier(
            deps.db,
            parseOrThrow(idSchema, c.req.param("id")),
            c.get("principal"),
          )),
          generation,
        },
        200,
        { "Cache-Control": "private, no-store" },
      ),
    )
    .put("/suppliers/:id", async (c) =>
      c.json(
        await saveSupplier(
          deps.db,
          parseOrThrow(idSchema, c.req.param("id")),
          parseOrThrow(supplierInputSchema, await readJson(c)),
          c.get("principal"),
          generation,
        ),
      ),
    )
    .get("/receipts", async (c) =>
      c.json(
        {
          ...(await listStockReceipts(
            deps.db,
            parseOrThrow(stockReceiptQuerySchema, c.req.query()),
            c.get("principal"),
          )),
          generation,
        },
        200,
        { "Cache-Control": "private, no-store" },
      ),
    )
    .get("/receipts/:id", async (c) =>
      c.json(
        {
          ...(await getStockReceipt(
            deps.db,
            parseOrThrow(idSchema, c.req.param("id")),
            c.get("principal"),
          )),
          generation,
        },
        200,
        { "Cache-Control": "private, no-store" },
      ),
    )
    .post("/receipts", async (c) =>
      c.json(
        await receiveStockDocument(
          deps.db,
          parseOrThrow(stockReceiptInputSchema, await readJson(c)),
          c.get("principal"),
          generation,
        ),
        201,
      ),
    )
    .get("/products/report", async (c) =>
      c.json(
        await inventoryReport(
          deps.db,
          parseOrThrow(productFiltersSchema, c.req.query()),
          c.get("principal"),
        ),
        200,
        { "Cache-Control": "private, no-store" },
      ),
    )
    .get("/products/export", (c) =>
      exportInventory(
        deps.db,
        parseOrThrow(productExportQuerySchema, c.req.query()),
        c.get("principal"),
        c.req.raw.method === "HEAD",
      ),
    )
    .get("/movements/export", (c) =>
      exportStockLedger(
        deps.db,
        parseOrThrow(stockLedgerFiltersSchema, c.req.query()),
        c.get("principal"),
        generation,
        c.req.raw.method === "HEAD",
      ),
    )
    .get("/movements", async (c) =>
      c.json(
        await stockLedger(
          deps.db,
          parseOrThrow(stockLedgerQuerySchema, c.req.query()),
          c.get("principal"),
          generation,
        ),
        200,
        { "Cache-Control": "private, no-store" },
      ),
    )
    .get("/products", async (c) =>
      c.json(
        await listProducts(
          deps.db,
          parseOrThrow(productQuerySchema, c.req.query()),
          c.get("principal"),
        ),
      ),
    )
    .post("/products", async (c) =>
      c.json(
        {
          ...(await createProduct(
            deps.db,
            parseOrThrow(createProductSchema, await readJson(c)),
            c.get("principal"),
          )),
          inventoryGeneration: generation,
        },
        201,
      ),
    )
    .get("/products/:id", async (c) =>
      c.json(
        {
          ...(await getProduct(
            deps.db,
            parseOrThrow(idSchema, c.req.param("id")),
            c.get("principal"),
          )),
          inventoryGeneration: generation,
        },
        200,
        { "Cache-Control": "private, no-store" },
      ),
    )
    .get("/products/:id/photo/:version", (c) =>
      readProductPhoto(
        deps.db,
        parseOrThrow(idSchema, c.req.param("id")),
        parseOrThrow(idSchema, c.req.param("version")),
        c.get("principal"),
      ),
    )
    .put("/products/:id/photo", async (c) =>
      c.json(
        await saveProductPhoto(
          deps.db,
          parseOrThrow(idSchema, c.req.param("id")),
          parseOrThrow(productPhotoInputSchema, await readJson(c)),
          c.get("principal"),
        ),
      ),
    )
    .patch("/products/:id", async (c) =>
      c.json({
        ...(await updateProduct(
          deps.db,
          parseOrThrow(idSchema, c.req.param("id")),
          parseOrThrow(updateProductSchema, await readJson(c)),
          c.get("principal"),
        )),
        inventoryGeneration: generation,
      }),
    )
    .patch("/products/:id/package-content", async (c) =>
      c.json({
        ...(await updateProduct(
          deps.db,
          parseOrThrow(idSchema, c.req.param("id")),
          parseOrThrow(updatePackageContentSchema, await readJson(c)),
          c.get("principal"),
        )),
        inventoryGeneration: generation,
      }),
    )
    .get("/products/:id/movements", async (c) => {
      const query = parseOrThrow(productQuerySchema, c.req.query());
      return c.json(
        {
          ...(await listMovements(
            deps.db,
            parseOrThrow(idSchema, c.req.param("id")),
            query.page,
            query.pageSize,
            c.get("principal"),
          )),
          inventoryGeneration: generation,
        },
        200,
        { "Cache-Control": "private, no-store" },
      );
    })
    .post("/products/:id/movements", async (c) => {
      const movement = parseOrThrow(stockMovementInputSchema, await readJson(c));
      return c.json(
        {
          ...(await moveStock(
            deps.db,
            parseOrThrow(idSchema, c.req.param("id")),
            movement,
            c.get("principal"),
            generation,
          )),
          inventoryGeneration: generation,
        },
        201,
      );
    })
    .post("/returns", async (c) =>
      c.json(
        await returnStock(
          deps.db,
          parseOrThrow(stockReturnSchema, await readJson(c)),
          c.get("principal"),
          generation,
        ),
        201,
      ),
    );
}
