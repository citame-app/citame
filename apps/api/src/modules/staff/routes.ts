import { Hono } from "hono";
import type { AppDeps } from "../../app";
import { listStaff } from "./service";

export function staffRoutes({ db }: AppDeps) {
  return new Hono().get("/", async (c) => c.json({ staff: await listStaff(db) }));
}
