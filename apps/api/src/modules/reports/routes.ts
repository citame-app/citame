import {
  permissionsFor,
  reportOutcomesQuerySchema,
  reportQuerySchema,
  reportSummaryQuerySchema,
} from "@sob/contracts";
import { Hono } from "hono";
import type { AppDeps } from "../../app";
import { authorizeClientAccess, authorizeReportQuery, requirePermission } from "../../auth/policy";
import type { AppEnv } from "../../auth/principal";
import { parseOrThrow } from "../../http";
import { reportClients } from "./clients";
import { reportOutcomes, reportOutcomesCsv } from "./outcomes";
import { reportSummary } from "./service";

/** Reporting, mounted at `/admin/reports` behind `requireAuth`. */
export function reportRoutes({ db }: AppDeps) {
  return new Hono<AppEnv>()
    .get("/summary", async (c) => {
      const { businessOverview, ...query } = parseOrThrow(reportSummaryQuerySchema, c.req.query());
      const principal = c.get("principal");
      const scoped = authorizeReportQuery(principal, query);
      const access = permissionsFor(principal.role, principal.accessPreset);
      const summary = await reportSummary(
        db,
        scoped,
        businessOverview === "1" &&
          access.financialReports &&
          access.clients &&
          access.commerce &&
          access.allSales &&
          access.readInventory,
      );
      c.header("Cache-Control", "private, no-store");
      return c.json({
        ...summary,
        canReportClients: access.financialReports,
      });
    })
    .get("/clients", async (c) => {
      const principal = c.get("principal");
      requirePermission(principal, "financialReports");
      authorizeClientAccess(principal);
      const query = parseOrThrow(reportQuerySchema, c.req.query());
      const scoped = authorizeReportQuery(principal, query);
      return c.json(await reportClients(db, scoped), 200, { "Cache-Control": "private, no-store" });
    })
    .get("/outcomes", async (c) => {
      const query = parseOrThrow(reportOutcomesQuerySchema, c.req.query());
      const principal = c.get("principal");
      const scoped = authorizeReportQuery(principal, query);
      authorizeClientAccess(principal);
      c.header("Cache-Control", "private, no-store");
      return c.json(await reportOutcomes(db, { ...query, ...scoped }));
    })
    .on(["GET", "HEAD"], "/outcomes/export", async (c) => {
      const query = parseOrThrow(reportOutcomesQuerySchema, c.req.query());
      const principal = c.get("principal");
      const scoped = authorizeReportQuery(principal, query);
      authorizeClientAccess(principal);
      return reportOutcomesCsv(db, { ...query, ...scoped }, c.req.method === "HEAD");
    });
}
