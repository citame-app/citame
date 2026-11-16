import { expect, test } from "bun:test";
import { clientControlsInputSchema } from "./client-controls";

test("client tags normalize case and whitespace, reject duplicates and bound profile updates", () => {
  expect(
    clientControlsInputSchema.parse({ version: 1, tags: [" VIP ", "Coloración"] }).tags,
  ).toEqual(["vip", "coloración"]);
  expect(clientControlsInputSchema.safeParse({ version: 1, tags: ["VIP", "vip"] }).success).toBe(
    false,
  );
  expect(clientControlsInputSchema.safeParse({ version: 1 }).success).toBe(false);
  expect(
    clientControlsInputSchema.safeParse({ version: 1, bookingAccess: "blocked" }).success,
  ).toBe(false);
  expect(
    clientControlsInputSchema.safeParse({
      version: 1,
      bookingAccess: "trusted",
      reason: "Known customer",
    }).success,
  ).toBe(true);
});
