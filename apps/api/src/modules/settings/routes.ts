import type { SalonResponse } from "@sob/contracts";
import { Hono } from "hono";
import type { AppDeps } from "../../app";
import { getSalonSettings } from "./service";

/** Public: the booking site shows the salon name and renders every time in its timezone. */
export function salonRoutes({ db }: Pick<AppDeps, "db">) {
  return new Hono().get("/", async (c) => {
    const settings = await getSalonSettings(db);
    const body: SalonResponse = {
      name: settings.name,
      timezone: settings.timezone,
      slotGranularityMinutes: settings.slotGranularityMinutes,
      minNoticeMinutes: settings.minNoticeMinutes,
      maxDaysAhead: settings.maxDaysAhead,
    };
    return c.json(body);
  });
}
