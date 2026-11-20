import { visitAvailabilitySchema } from "@sob/contracts";
import { Hono } from "hono";
import type { AppDeps } from "../../app";
import { parseOrThrow, readJson } from "../../http";
import { findVisitAvailability } from "../appointments/visits";
import { listCombinations } from "./combinations";
import { listServices } from "./service";

export function servicesRoutes({ db, now = () => new Date() }: AppDeps) {
  return new Hono()
    .post("/visit-availability", async (c) =>
      c.json(
        await findVisitAvailability(
          db,
          parseOrThrow(visitAvailabilitySchema, await readJson(c)),
          now(),
        ),
      ),
    )
    .get("/combinations", async (c) => c.json(await listCombinations(db)))
    .get("/", async (c) => c.json({ services: await listServices(db) }));
}
