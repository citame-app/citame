import { peakPricePolicySchema, peakPriceQuerySchema } from "@sob/contracts";
import { Hono } from "hono";
import type { AppDeps } from "../../app";
import { requirePermission } from "../../auth/policy";
import type { AppEnv } from "../../auth/principal";
import { parseOrThrow, readJson } from "../../http";
import { previewPeakSlot, readPeakPricePolicy, savePeakPricePolicy } from "./service";

export function peakPriceAdminRoutes({ db, config }: AppDeps) {
  return new Hono<AppEnv>()
    .get("/", async (c) => {
      requirePermission(c.get("principal"), "editCatalog");
      return c.json(await readPeakPricePolicy(db, config.syncReplicaGeneration), 200, {
        "Cache-Control": "private, no-store",
      });
    })
    .put("/", async (c) =>
      c.json(
        await savePeakPricePolicy(
          db,
          parseOrThrow(peakPricePolicySchema, await readJson(c)),
          c.get("principal"),
          config.syncReplicaGeneration,
        ),
      ),
    );
}

export function peakPricePreviewRoute({ db }: AppDeps, publicOnly: boolean) {
  return new Hono<AppEnv>().get("/", async (c) => {
    const principal = publicOnly ? undefined : c.get("principal");
    if (principal && principal.role !== "client") requirePermission(principal, "editCalendar");
    const query = parseOrThrow(peakPriceQuerySchema, c.req.query());
    return c.json(
      await previewPeakSlot(
        db,
        query.serviceIds,
        query.startsAt,
        publicOnly || principal?.role === "client",
        query.combinationId,
      ),
      200,
      { "Cache-Control": "no-store" },
    );
  });
}
