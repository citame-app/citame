import { reportQuerySchema } from "@sob/contracts";
import { Hono } from "hono";
import type { AppDeps } from "../../app";
import { authorizeReportQuery } from "../../auth/policy";
import type { AppEnv } from "../../auth/principal";
import { parseOrThrow } from "../../http";
import { reportSummary } from "./service";

/** Reporting, mounted at `/admin/reports` behind `requireAuth`. */
export function reportRoutes({ db }: AppDeps) {
  return new Hono<AppEnv>().get("/summary", async (c) => {
    const query = parseOrThrow(reportQuerySchema, c.req.query());
    const scoped = authorizeReportQuery(c.get("principal"), query);
    return c.json(await reportSummary(db, scoped));
  });
}
