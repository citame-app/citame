import { expect, test } from "bun:test";
import { cashAdjustmentSchema, createCheckoutSchema, startPaymentSchema } from "./commerce";

const key = "checkout-test-key";
test("retail checkout accepts priced custom lines but never a client-supplied catalog price", () => {
  expect(
    createCheckoutSchema.parse({
      lines: [
        { kind: "custom", description: "Hair treatment", quantity: 1, unitAmountCents: 2500 },
      ],
      idempotencyKey: key,
    }).currency,
  ).toBe("EUR");
  for (const line of [
    { kind: "product", quantity: 1 },
    { kind: "product", productId: crypto.randomUUID(), quantity: 1, unitAmountCents: 1 },
    { kind: "custom", quantity: 1 },
    { kind: "custom", description: " ", quantity: 1, unitAmountCents: 100 },
  ])
    expect(createCheckoutSchema.safeParse({ lines: [line], idempotencyKey: key }).success).toBe(
      false,
    );
});
test("checkout and payment reject fractional money, empty carts, forged totals and unsafe request keys", () => {
  expect(createCheckoutSchema.safeParse({ lines: [], idempotencyKey: key }).success).toBe(false);
  expect(
    createCheckoutSchema.safeParse({
      appointmentId: crypto.randomUUID(),
      totalCents: 1,
      idempotencyKey: key,
    }).success,
  ).toBe(false);
  for (const amountCents of [0, -1, 0.1, 1e12])
    expect(
      startPaymentSchema.safeParse({ amountCents, method: "cash", idempotencyKey: key }).success,
    ).toBe(false);
  expect(
    startPaymentSchema.safeParse({
      amountCents: 100,
      method: "cash",
      idempotencyKey: "unsafe\nkey",
    }).success,
  ).toBe(false);
  expect(
    cashAdjustmentSchema.safeParse({
      amountCents: 100,
      kind: "withdrawal",
      reason: " ",
      idempotencyKey: key,
    }).success,
  ).toBe(false);
});
