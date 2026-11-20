import { idSchema } from "@sob/contracts";
import { Hono } from "hono";
import type { AppDeps } from "../../app";
import { parseOrThrow } from "../../http";
import { readPublishedStaffPortrait } from "./portrait";
import { listStaff } from "./service";

export function staffRoutes({ db }: AppDeps) {
  return new Hono()
    .get("/", async (c) => c.json({ staff: await listStaff(db) }))
    .get("/:id/portrait/:version", (c) => {
      c.header("Cache-Control", "no-store");
      return readPublishedStaffPortrait(
        db,
        parseOrThrow(idSchema, c.req.param("id")),
        parseOrThrow(idSchema, c.req.param("version")),
      );
    });
}
