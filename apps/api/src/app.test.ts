import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { errorResponseSchema, healthResponseSchema } from "@sob/contracts";
import { setupApiTest } from "../test/helpers";

let t: Awaited<ReturnType<typeof setupApiTest>>;

beforeAll(async () => {
  t = await setupApiTest();
});

afterAll(async () => {
  await t.close();
});

describe("app", () => {
  test("GET /health returns ok", async () => {
    const res = await t.app.request("/health");
    expect(res.status).toBe(200);
    expect(healthResponseSchema.parse(await res.json())).toEqual({ status: "ok" });
  });

  test("unknown routes return the stable not_found error shape", async () => {
    const res = await t.app.request("/nope");
    expect(res.status).toBe(404);
    expect(errorResponseSchema.parse(await res.json()).error.code).toBe("not_found");
  });
});
