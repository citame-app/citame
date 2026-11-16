import { expect, test } from "bun:test";
import { createServiceRequestSchema } from "./services";

const parentServiceId = "0198f5a0-7b1c-7000-8000-000000000101";
test("variant creation preserves its explicit parent and option label", () => {
  const catalog = { kind: "variant", parentServiceId, optionLabel: "Long hair" };
  expect(
    createServiceRequestSchema.parse({
      name: "Haircut · Long hair",
      durationMinutes: 60,
      priceCents: 5000,
      catalog,
    }),
  ).toMatchObject({ catalog });
  expect(
    createServiceRequestSchema.safeParse({
      name: "Invalid",
      durationMinutes: 60,
      priceCents: 5000,
      catalog: { ...catalog, optionLabel: " " },
    }).success,
  ).toBe(false);
});
test("a price-only add-on has explicit eligible services and may add zero minutes", () => {
  const catalog = { kind: "addon", allowedServiceIds: [parentServiceId] };
  expect(
    createServiceRequestSchema.safeParse({
      name: "Finish",
      durationMinutes: 0,
      priceCents: 500,
      catalog,
    }).success,
  ).toBe(true);
  expect(
    createServiceRequestSchema.safeParse({
      name: "Finish",
      durationMinutes: 5,
      priceCents: 500,
      catalog: { kind: "addon", allowedServiceIds: [] },
    }).success,
  ).toBe(false);
  expect(
    createServiceRequestSchema.safeParse({
      name: "Finish",
      durationMinutes: 5,
      priceCents: 500,
      catalog: { kind: "addon", allowedServiceIds: [parentServiceId, parentServiceId] },
    }).success,
  ).toBe(false);
});
