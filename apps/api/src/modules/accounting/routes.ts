import {
  commissionPayoutInputSchema,
  commissionPolicyInputSchema,
  idSchema,
  reportQuerySchema,
} from "@sob/contracts";
import { Hono } from "hono";
import { z } from "zod";
import type { AppDeps } from "../../app";
import { requireRole } from "../../auth/policy";
import type { AppEnv } from "../../auth/principal";
import { parseOrThrow, readJson } from "../../http";
import { commissionStatement, getPolicy, recordPayout, salesReport, setPolicy } from "./service";

const pages = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  payoutPage: z.coerce.number().int().min(1).max(100000).default(1),
});
export function accountingRoutes(deps: AppDeps) {
  return new Hono<AppEnv>()
    .use("*", async (c, next) => {
      requireRole(c.get("principal"), "owner", "staff");
      if (c.req.method !== "GET") requireRole(c.get("principal"), "owner");
      await next();
    })
    .get("/staff/:id/policy", async (c) =>
      c.json(
        await getPolicy(deps.db, parseOrThrow(idSchema, c.req.param("id")), c.get("principal")),
      ),
    )
    .put("/staff/:id/policy", async (c) =>
      c.json(
        await setPolicy(
          deps.db,
          parseOrThrow(idSchema, c.req.param("id")),
          parseOrThrow(commissionPolicyInputSchema, await readJson(c)),
          c.get("principal"),
        ),
      ),
    )
    .get("/staff/:id/statement", async (c) => {
      const query = parseOrThrow(pages, c.req.query());
      return c.json(
        await commissionStatement(
          deps.db,
          parseOrThrow(idSchema, c.req.param("id")),
          c.get("principal"),
          query.page,
          query.payoutPage,
        ),
      );
    })
    .post("/staff/:id/payouts", async (c) =>
      c.json(
        await recordPayout(
          deps.db,
          parseOrThrow(idSchema, c.req.param("id")),
          parseOrThrow(commissionPayoutInputSchema, await readJson(c)),
          c.get("principal"),
        ),
        201,
      ),
    )
    .get("/sales", async (c) => {
      requireRole(c.get("principal"), "owner");
      return c.json(
        await salesReport(
          deps.db,
          parseOrThrow(reportQuerySchema, c.req.query()),
          c.get("principal"),
        ),
      );
    });
}
