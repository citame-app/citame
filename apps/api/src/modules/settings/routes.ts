import { idSchema } from "@sob/contracts";
import { Hono } from "hono";
import type { AppDeps } from "../../app";
import { parseOrThrow } from "../../http";
import { getBookingPolicy } from "../booking-protection/policy";
import { readProfileImage, reviewPublicProfile } from "./profile-media";
import { getSalonSettings, toSalonResponse } from "./service";

/** Public: the booking site shows the salon name and renders every time in its timezone. */
export function salonRoutes({ db }: Pick<AppDeps, "db">) {
  return new Hono()
    .get("/booking-policy", async (c) => c.json(await getBookingPolicy(db)))
    .get("/profile", async (c) =>
      c.json(await reviewPublicProfile(db), 200, { "Cache-Control": "no-store" }),
    )
    .get("/profile/images/:id/:version", (c) =>
      readProfileImage(
        db,
        parseOrThrow(idSchema, c.req.param("id")),
        parseOrThrow(idSchema, c.req.param("version")),
        true,
      ),
    )
    .get("/", async (c) => c.json(toSalonResponse(await getSalonSettings(db))));
}
