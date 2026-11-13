import { expect, test } from "bun:test";
import { healthResponseSchema } from "./index";

test("healthResponseSchema accepts the ok payload", () => {
  expect(healthResponseSchema.parse({ status: "ok" })).toEqual({ status: "ok" });
});

test("healthResponseSchema rejects other statuses", () => {
  expect(healthResponseSchema.safeParse({ status: "down" }).success).toBe(false);
});
