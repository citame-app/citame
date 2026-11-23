import { availabilityQuerySchema } from "@sob/contracts";
import { Hono } from "hono";
import type { AppDeps } from "../../app";
import { parseOrThrow } from "../../http";
import { findAvailability } from "./service";

export function availabilityRoutes({ db, now = () => new Date() }: AppDeps) {
  return new Hono().get("/", async (c) => {
    const query = parseOrThrow(availabilityQuerySchema, c.req.query());
    return c.json(await findAvailability(db, query, now(), { publicOnlyFixed: true }));
  });
}
