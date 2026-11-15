import { expect, test } from "bun:test";
import { commissionPayoutInputSchema, commissionPolicyInputSchema } from "./accounting";

test("commission rates are bounded percentages and policy updates require a revision", () => {
  expect(
    commissionPolicyInputSchema.parse({
      serviceBasisPoints: 2500,
      productBasisPoints: 1000,
      version: null,
    }),
  ).toMatchObject({ serviceBasisPoints: 2500 });
  expect(
    commissionPolicyInputSchema.safeParse({
      serviceBasisPoints: 10001,
      productBasisPoints: 0,
      version: null,
    }).success,
  ).toBe(false);
  expect(
    commissionPolicyInputSchema.safeParse({ serviceBasisPoints: 2500, productBasisPoints: 0 })
      .success,
  ).toBe(false);
});
test("recorded commission payouts require positive money, a reference and an idempotency key", () => {
  expect(
    commissionPayoutInputSchema.safeParse({
      amountCents: 100,
      reference: "Bank transfer 123",
      idempotencyKey: "payout-123",
    }).success,
  ).toBe(true);
  expect(
    commissionPayoutInputSchema.safeParse({
      amountCents: 0,
      reference: "Bank transfer 123",
      idempotencyKey: "payout-123",
    }).success,
  ).toBe(false);
});
