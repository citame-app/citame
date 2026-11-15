import { expect, test } from "bun:test";
import { startPaymentSchema } from "./commerce";
import { giftCardCodeSchema, giftCardPurchaseSchema } from "./gift-cards";

test("gift card purchase requires positive integer value and a replay key", () => {
  expect(
    giftCardPurchaseSchema.safeParse({
      amountCents: 10000,
      label: "Birthday",
      idempotencyKey: "gift-card-123",
    }).success,
  ).toBe(true);
  expect(
    giftCardPurchaseSchema.safeParse({ amountCents: 0, idempotencyKey: "gift-card-123" }).success,
  ).toBe(false);
  expect(giftCardCodeSchema.parse(" sob-abcd-1234-abcd-1234-abcd-1234 ")).toBe(
    "SOBABCD1234ABCD1234ABCD1234",
  );
});
test("gift card tender requires its code and other tender methods cannot carry one", () => {
  expect(
    startPaymentSchema.safeParse({
      method: "gift_card",
      amountCents: 1000,
      idempotencyKey: "payment-123",
    }).success,
  ).toBe(false);
  expect(
    startPaymentSchema.safeParse({
      method: "gift_card",
      giftCardCode: "SOB-ABCD-1234-ABCD-1234-ABCD-1234",
      amountCents: 1000,
      idempotencyKey: "payment-123",
    }).success,
  ).toBe(true);
  expect(
    startPaymentSchema.safeParse({
      method: "cash",
      giftCardCode: "SOB-ABCD-1234-ABCD-1234-ABCD-1234",
      amountCents: 1000,
      idempotencyKey: "payment-123",
    }).success,
  ).toBe(false);
});
