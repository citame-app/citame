import { expect, test } from "bun:test";
import type { Service } from "@sob/contracts";
import { extraIsEligible, type ReceiptItem, receiptInput } from "./pos-cart";

const base: ReceiptItem = {
  key: "product:a",
  kind: "product",
  id: "a",
  name: "Item",
  priceCents: 1999,
  quantity: "3",
  available: 4,
};
test("receipt percentages and tips are exact cents and catalog prices stay off the wire", () => {
  const receipt = receiptInput([base], "12,5", "percent", "1.50");
  expect(receipt).toMatchObject({
    valid: true,
    subtotal: 5997,
    discountCents: 750,
    tipCents: 150,
    total: 5397,
  });
  expect(receipt.lines).toEqual([
    { kind: "product", productId: "a", quantity: 3, taxBasisPoints: 0 },
  ]);
});
test("a reviewed unit price changes only the selected catalog line", () => {
  const catalogPriceReview = {
    expectedUnitAmountCents: base.priceCents,
    unitAmountCents: 1210,
    reason: "Agreed amount",
  };
  const cart = receiptInput([{ ...base, catalogPriceReview }], "100", "fixed", "0");
  expect(cart.subtotal).toBe(3630);
  expect(cart.valid).toBe(false);
  expect(receiptInput([{ ...base, catalogPriceReview }], "10", "percent", "0").lines).toEqual([
    { kind: "product", productId: "a", quantity: 3, taxBasisPoints: 0, catalogPriceReview },
  ]);
});
test("receipt blocks overselling, malformed quantities, excessive discounts and amount overflows", () => {
  for (const quantity of ["", "0", "1.5", "5", "1001"])
    expect(receiptInput([{ ...base, quantity }], "0", "fixed", "0").valid).toBe(false);
  expect(receiptInput([base], "100.01", "percent", "0").valid).toBe(false);
  expect(receiptInput([base], "60", "fixed", "0").valid).toBe(false);
  expect(
    receiptInput([{ ...base, priceCents: 999999999, quantity: "2" }], "0", "fixed", "0").valid,
  ).toBe(false);
});
test("an extra requires its compatible service or variant to remain in the basket", () => {
  const service: Service = {
    id: "base",
    name: "Treatment",
    description: null,
    durationMinutes: 30,
    bufferMinutes: 0,
    priceCents: 3000,
    currency: "EUR",
  };
  const extra: Service = {
    ...service,
    id: "extra",
    catalog: { kind: "addon", version: 1, allowedServiceIds: ["base"] },
  };
  const line: ReceiptItem = {
    key: "service:extra",
    kind: "service",
    id: "extra",
    name: "Extra",
    priceCents: 500,
    quantity: "1",
    service: extra,
  };
  expect(extraIsEligible(extra, [])).toBe(false);
  expect(receiptInput([line], "0", "fixed", "0").valid).toBe(false);
  expect(
    receiptInput([{ ...line, key: "service:base", id: "base", service }, line], "0", "fixed", "0")
      .valid,
  ).toBe(true);
});
