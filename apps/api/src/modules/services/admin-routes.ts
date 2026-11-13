import {
  createServiceRequestSchema,
  idSchema,
  setServiceStaffRequestSchema,
  updateServiceRequestSchema,
} from "@sob/contracts";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { AppDeps } from "../../app";
import { authorizeServiceAdmin } from "../../auth/policy";
import type { AppEnv } from "../../auth/principal";
import { parseOrThrow, readJson } from "../../http";
import {
  createService,
  deactivateService,
  listAdminServices,
  setServiceStaff,
  updateService,
} from "./admin";

const ownerOnly = createMiddleware<AppEnv>(async (c, next) => {
  authorizeServiceAdmin(c.get("principal"));
  await next();
});

/** Owner-only catalog administration, mounted at `/admin/services` behind `requireAuth`. */
export function serviceAdminRoutes({ db }: AppDeps) {
  return new Hono<AppEnv>()
    .get("/", ownerOnly, async (c) => c.json({ services: await listAdminServices(db) }))
    .post("/", ownerOnly, async (c) => {
      const body = parseOrThrow(createServiceRequestSchema, await readJson(c));
      return c.json(await createService(db, body, c.get("principal")), 201);
    })
    .patch("/:id", ownerOnly, async (c) => {
      const id = parseOrThrow(idSchema, c.req.param("id"));
      const body = parseOrThrow(updateServiceRequestSchema, await readJson(c));
      return c.json(await updateService(db, id, body, c.get("principal")));
    })
    .delete("/:id", ownerOnly, async (c) => {
      const id = parseOrThrow(idSchema, c.req.param("id"));
      return c.json(await deactivateService(db, id, c.get("principal")));
    })
    .put("/:id/staff", ownerOnly, async (c) => {
      const id = parseOrThrow(idSchema, c.req.param("id"));
      const body = parseOrThrow(setServiceStaffRequestSchema, await readJson(c));
      return c.json(await setServiceStaff(db, id, body, c.get("principal")));
    });
}
