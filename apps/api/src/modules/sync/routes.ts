import { syncPullQuerySchema } from "@sob/contracts";
import { Hono } from "hono";
import type { AppDeps } from "../../app";
import { requireRole } from "../../auth/policy";
import type { AppEnv } from "../../auth/principal";
import { parseOrThrow } from "../../http";
import { pullChanges } from "./pull";

/** Mounted at `/sync` behind `requireAuth`. Sync is for the front desk: owner and staff only. */
export function syncRoutes({ db }: AppDeps) {
  return new Hono<AppEnv>()
    .use("*", async (c, next) => {
      requireRole(c.get("principal"), "owner", "staff");
      await next();
    })
    .get("/pull", async (c) => {
      const query = parseOrThrow(syncPullQuerySchema, c.req.query());
      return c.json(await pullChanges(db, c.get("principal"), query));
    });
}
