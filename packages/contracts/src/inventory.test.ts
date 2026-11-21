import { expect, test } from "bun:test";
import { z } from "zod";
import {
  createProductSchema,
  productSchema,
  stockMovementInputSchema,
  updateProductSchema,
} from "./inventory";

test("a price-only patch does not reset tax, units or stock alert settings", () => {
  expect(updateProductSchema.parse({ version: 2, priceCents: 2500 })).toEqual({
    version: 2,
    priceCents: 2500,
  });
});
test("SKUs normalize consistently and unknown cost differs from a known zero cost", () => {
  const value = createProductSchema.parse({
    name: "Shampoo",
    sku: "shampoo-250",
    priceCents: 2000,
    idempotencyKey: "product-test-key",
  });
  expect(value.sku).toBe("SHAMPOO-250");
  expect(value.costCents).toBeUndefined();
  expect(createProductSchema.parse({ ...value, costCents: 0 }).costCents).toBe(0);
});
test("physical consumption is positive but an inventory count can explicitly be zero", () => {
  const base = {
    version: 1,
    reason: "Physical check",
    idempotencyKey: "stock-test-key",
    generation: "initial",
  };
  expect(
    stockMovementInputSchema.safeParse({ ...base, kind: "consume", quantity: 0 }).success,
  ).toBe(false);
  expect(stockMovementInputSchema.safeParse({ ...base, kind: "count", quantity: 0 }).success).toBe(
    true,
  );
  expect(
    stockMovementInputSchema.safeParse({ ...base, kind: "count", quantity: 0.5 }).success,
  ).toBe(false);
});

test("inventory classification IDs are representable in product tool JSON schemas", () => {
  for (const schema of [createProductSchema, updateProductSchema, productSchema]) {
    expect(z.toJSONSchema(schema).properties).toHaveProperty("classification");
  }
});
