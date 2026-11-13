import { Hono } from "hono";
import type { AppDeps } from "../../app";
import { listServices } from "./service";

export function servicesRoutes({ db }: AppDeps) {
  return new Hono().get("/", async (c) => c.json({ services: await listServices(db) }));
}
