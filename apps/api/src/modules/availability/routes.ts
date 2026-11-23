import { availabilityQuerySchema } from "@sob/contracts";
import { Hono } from "hono";
import type { AppDeps } from "../../app";
import { DomainError } from "../../errors";
import { parseOrThrow } from "../../http";
import { onlineServicesByIds } from "../services/service";
import { findAvailability } from "./service";

export function availabilityRoutes({ db, now = () => new Date() }: AppDeps) {
  return new Hono().get("/", async (c) => {
    const query = parseOrThrow(availabilityQuerySchema, c.req.query());
    if (
      query.combinationId &&
      (await onlineServicesByIds(db, query.serviceIds)).length !== query.serviceIds.length
    )
      throw new DomainError("not_found", "Combination unavailable for online booking");
    return c.json(await findAvailability(db, query, now(), { publicOnlyFixed: true }));
  });
}
