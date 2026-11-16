import { expect, test } from "bun:test";
import {
  resourceCreateSchema,
  resourceUpdateSchema,
  serviceResourceInputSchema,
} from "./resources";

const id = "0198f5a0-7b1c-7000-8000-000000000101";
test("resource creation trims names and bounds interchangeable units", () => {
  const input = { name: " Cabina ", kind: "room", capacity: 1, idempotencyKey: "resource-request" };
  expect(resourceCreateSchema.parse(input).name).toBe("Cabina");
  for (const capacity of [0, 21, 1.5, Infinity])
    expect(resourceCreateSchema.safeParse({ ...input, capacity }).success).toBe(false);
  expect(resourceCreateSchema.safeParse({ ...input, name: " " }).success).toBe(false);
  expect(resourceCreateSchema.safeParse({ ...input, active: true }).success).toBe(false);
});
test("editing requires the reviewed positive revision and explicit active state", () => {
  const input = { name: "Cabina", kind: "room", capacity: 2, active: true, version: 1 };
  expect(resourceUpdateSchema.safeParse(input).success).toBe(true);
  expect(resourceUpdateSchema.safeParse({ ...input, version: 0 }).success).toBe(false);
  expect(resourceUpdateSchema.safeParse({ ...input, active: undefined }).success).toBe(false);
});
test("requirements remove with an empty list and reject duplicate or excessive claims", () => {
  expect(serviceResourceInputSchema.parse({ version: 1, requirements: [] }).requirements).toEqual(
    [],
  );
  const claim = { resourceId: id, quantity: 1 };
  expect(
    serviceResourceInputSchema.safeParse({ version: 1, requirements: [claim, claim] }).success,
  ).toBe(false);
  for (const quantity of [0, 21, 1.5])
    expect(
      serviceResourceInputSchema.safeParse({ version: 1, requirements: [{ ...claim, quantity }] })
        .success,
    ).toBe(false);
  expect(
    serviceResourceInputSchema.safeParse({ version: 1, requirements: [{ ...claim, capacity: 20 }] })
      .success,
  ).toBe(false);
});
