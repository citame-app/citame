import {
  createProductSchema,
  idSchema,
  productQuerySchema,
  stockMovementInputSchema,
  stockReturnSchema,
  updateProductSchema,
} from "@sob/contracts";
import { Hono } from "hono";
import type { AppDeps } from "../../app";
import { requireRole } from "../../auth/policy";
import type { AppEnv } from "../../auth/principal";
import { parseOrThrow, readJson } from "../../http";
import {
  createProduct,
  getProduct,
  listMovements,
  listProducts,
  moveStock,
  returnStock,
  updateProduct,
} from "./service";
export function inventoryRoutes(deps: AppDeps) {
  return new Hono<AppEnv>()
    .use("*", async (c, next) => {
      requireRole(c.get("principal"), "owner", "staff");
      if (c.req.method !== "GET") requireRole(c.get("principal"), "owner");
      await next();
    })
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
        await createProduct(
          deps.db,
          parseOrThrow(createProductSchema, await readJson(c)),
          c.get("principal"),
        ),
        201,
      ),
    )
    .get("/products/:id", async (c) =>
      c.json(
        await getProduct(deps.db, parseOrThrow(idSchema, c.req.param("id")), c.get("principal")),
      ),
    )
    .patch("/products/:id", async (c) =>
      c.json(
        await updateProduct(
          deps.db,
          parseOrThrow(idSchema, c.req.param("id")),
          parseOrThrow(updateProductSchema, await readJson(c)),
          c.get("principal"),
        ),
      ),
    )
    .get("/products/:id/movements", async (c) => {
      const query = parseOrThrow(productQuerySchema, c.req.query());
      return c.json(
        await listMovements(
          deps.db,
          parseOrThrow(idSchema, c.req.param("id")),
          query.page,
          query.pageSize,
          c.get("principal"),
        ),
      );
    })
    .post("/products/:id/movements", async (c) =>
      c.json(
        await moveStock(
          deps.db,
          parseOrThrow(idSchema, c.req.param("id")),
          parseOrThrow(stockMovementInputSchema, await readJson(c)),
          c.get("principal"),
        ),
        201,
      ),
    )
    .post("/returns", async (c) =>
      c.json(
        await returnStock(
          deps.db,
          parseOrThrow(stockReturnSchema, await readJson(c)),
          c.get("principal"),
        ),
        201,
      ),
    );
}
