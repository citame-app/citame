import type { HealthResponse } from "@sob/contracts";
import { Hono } from "hono";

export const app = new Hono();

app.get("/health", (c) => {
  const body: HealthResponse = { status: "ok" };
  return c.json(body);
});
