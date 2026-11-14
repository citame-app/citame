import { syncPullQuerySchema, syncPushRequestSchema } from "@sob/contracts";
import { Hono } from "hono";
import type { AppDeps } from "../../app";
import { requireRole } from "../../auth/policy";
import type { AppEnv } from "../../auth/principal";
import { parseOrThrow, readJson } from "../../http";
import { pullChanges } from "./pull";
import { pushMutations } from "./push";

/** Mounted at `/sync` behind `requireAuth`. Sync is for the front desk: owner and staff only. */
export function syncRoutes({ db, now = () => new Date() }: AppDeps) {
  return new Hono<AppEnv>()
    .use("*", async (c, next) => {
      requireRole(c.get("principal"), "owner", "staff");
      await next();
    })
    .post("/push", async (c) => {
      const request = parseOrThrow(syncPushRequestSchema, await readJson(c));
      return c.json(await pushMutations({ db, now }, c.get("principal"), request));
    })
    .get("/pull", async (c) => {
      const query = parseOrThrow(syncPullQuerySchema, c.req.query());
      return c.json(await pullChanges(db, c.get("principal"), query));
    });
}
