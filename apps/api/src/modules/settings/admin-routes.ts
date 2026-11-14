import { updateSalonSettingsRequestSchema } from "@sob/contracts";
import { Hono } from "hono";
import type { AppDeps } from "../../app";
import { requireRole } from "../../auth/policy";
import type { AppEnv } from "../../auth/principal";
import { parseOrThrow, readJson } from "../../http";
import { getSalonSettings, toSalonResponse, updateSalonSettings } from "./service";

/** Owner-only salon settings, mounted at `/admin/settings` behind `requireAuth`. */
export function settingsAdminRoutes({ db }: AppDeps) {
  return new Hono<AppEnv>()
    .get("/", async (c) => {
      requireRole(c.get("principal"), "owner");
      return c.json(toSalonResponse(await getSalonSettings(db)));
    })
    .patch("/", async (c) => {
      const principal = c.get("principal");
      requireRole(principal, "owner");
      const body = parseOrThrow(updateSalonSettingsRequestSchema, await readJson(c));
      return c.json(await updateSalonSettings(db, body, principal));
    });
}
