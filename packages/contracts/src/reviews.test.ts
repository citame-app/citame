import { expect, test } from "bun:test";
import { reviewCreateSchema, reviewModerationSchema, reviewPublicQuerySchema } from "./reviews";

test("a review needs explicit publication permission, a chosen public name and bounded plain text", () => {
  const input = {
    appointmentId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    publicName: "  A.  ",
    rating: 5,
    body: " Lovely visit ",
    publicationConfirmed: true,
  };
  expect(reviewCreateSchema.parse(input)).toMatchObject({
    publicName: "A.",
    body: "Lovely visit",
    shareServices: false,
  });
  for (const change of [
    { publicationConfirmed: false },
    { publicName: " " },
    { rating: 1.5 },
    { rating: 6 },
    { body: "bad\u0000text" },
    { body: "x".repeat(2001) },
    { clientId: crypto.randomUUID() },
  ])
    expect(reviewCreateSchema.safeParse({ ...input, ...change }).success).toBe(false);
});
test("hiding requires a reason and public filtering and paging are bounded", () => {
  expect(reviewModerationSchema.safeParse({ version: 1, status: "hidden" }).success).toBe(false);
  expect(
    reviewModerationSchema.safeParse({
      version: 1,
      status: "hidden",
      reason: "Personal contact details",
    }).success,
  ).toBe(true);
  expect(reviewModerationSchema.safeParse({ version: 1, status: "withdrawn" }).success).toBe(false);
  expect(reviewPublicQuerySchema.parse({})).toMatchObject({ limit: 12 });
  expect(reviewPublicQuerySchema.safeParse({ limit: 1000 }).success).toBe(false);
});
