import { expect, test } from "bun:test";
import { appointmentServiceSchema } from "./appointments";
import { createServiceRequestSchema, serviceSchema } from "./services";

const base = { name: "Treatment", durationMinutes: 30, priceCents: 3000 };
test("an unknown or free price has no fixed charge, while a fixed quote requires one", () => {
  expect(
    createServiceRequestSchema.safeParse({
      name: base.name,
      durationMinutes: 30,
      priceType: "variable",
    }).success,
  ).toBe(true);
  expect(createServiceRequestSchema.safeParse({ ...base, priceType: "variable" }).success).toBe(
    false,
  );
  expect(createServiceRequestSchema.safeParse({ ...base, priceType: "free" }).success).toBe(false);
  expect(
    createServiceRequestSchema.safeParse({ name: base.name, durationMinutes: 30 }).success,
  ).toBe(false);
});
test("public prices and booked snapshots cannot describe a priced service as free or unknown", () => {
  const priced = {
    ...base,
    id: "0198f5a0-7b1c-7000-8000-000000000101",
    description: null,
    bufferMinutes: 0,
    currency: "EUR",
    priceType: "variable",
  };
  expect(serviceSchema.safeParse(priced).success).toBe(false);
  expect(appointmentServiceSchema.safeParse({ ...priced, serviceId: priced.id }).success).toBe(
    false,
  );
});
