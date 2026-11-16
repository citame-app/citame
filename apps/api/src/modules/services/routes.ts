import { Hono } from "hono";
import type { AppDeps } from "../../app";
import { listCombinations } from "./combinations";
import { listServices } from "./service";

export function servicesRoutes({ db }: AppDeps) {
  return new Hono()
    .get("/combinations", async (c) => c.json(await listCombinations(db)))
    .get("/", async (c) => c.json({ services: await listServices(db) }));
}
