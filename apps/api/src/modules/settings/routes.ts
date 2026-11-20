import { Hono } from "hono";
import type { AppDeps } from "../../app";
import { getBookingPolicy } from "../booking-protection/policy";
import { getSalonSettings, toSalonResponse } from "./service";

/** Public: the booking site shows the salon name and renders every time in its timezone. */
export function salonRoutes({ db }: Pick<AppDeps, "db">) {
  return new Hono()
    .get("/booking-policy", async (c) => c.json(await getBookingPolicy(db)))
    .get("/", async (c) => c.json(toSalonResponse(await getSalonSettings(db))));
}
