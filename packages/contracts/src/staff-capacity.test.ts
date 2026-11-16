import { expect, test } from "bun:test";
import { serviceSchema } from "./services";
import {
  processingTimeSchema,
  serviceProcessingInputSchema,
  staffCapacityInputSchema,
} from "./staff-capacity";
import { waitlistOfferSchema } from "./waitlist";

test("capacity is explicitly confirmed, bounded and versioned; processing can be removed explicitly", () => {
  expect(
    staffCapacityInputSchema.safeParse({ version: 1, maxConcurrent: 2, confirmed: true }).success,
  ).toBe(true);
  for (const input of [
    { version: 1, maxConcurrent: 2 },
    { version: 0, maxConcurrent: 1, confirmed: true },
    { version: 1, maxConcurrent: 7, confirmed: true },
  ])
    expect(staffCapacityInputSchema.safeParse(input).success).toBe(false);
  expect(
    serviceProcessingInputSchema.parse({ version: 1, processing: null }).processing,
  ).toBeNull();
  expect(processingTimeSchema.safeParse({ startsAfterMinutes: 0, minutes: 30 }).success).toBe(
    false,
  );
});
test("public service contracts reject a processing gap that consumes the final work interval", () => {
  expect(
    serviceSchema.safeParse({
      id: crypto.randomUUID(),
      name: "Colour",
      description: null,
      durationMinutes: 90,
      bufferMinutes: 0,
      priceCents: 1000,
      currency: "EUR",
      processing: { startsAfterMinutes: 30, minutes: 60 },
    }).success,
  ).toBe(false);
});
test("waitlist offer service terms retain processing and allow a price-only extra", () => {
  const member = {
    id: crypto.randomUUID(),
    name: "Colour",
    durationMinutes: 90,
    bufferMinutes: 0,
    priceCents: 1000,
    currency: "EUR",
    processing: { startsAfterMinutes: 30, minutes: 30 },
  };
  const schema = waitlistOfferSchema.shape.services;
  expect(schema.parse([member])[0]?.processing).toEqual(member.processing);
  expect(
    schema.safeParse([
      { ...member, processing: undefined, durationMinutes: 0, name: "Price-only extra" },
    ]).success,
  ).toBe(true);
});
