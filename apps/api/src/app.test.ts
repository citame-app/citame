import { expect, test } from "bun:test";
import { healthResponseSchema } from "@sob/contracts";
import { app } from "./app";

test("GET /health returns ok", async () => {
  const res = await app.request("/health");
  expect(res.status).toBe(200);
  expect(healthResponseSchema.parse(await res.json())).toEqual({ status: "ok" });
});
