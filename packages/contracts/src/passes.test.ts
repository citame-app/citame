import { expect, test } from "bun:test";
import { benefitPurchaseSchema, createBenefitPlanSchema } from "./passes";

const serviceId = "0198f5a0-7b1c-7000-8000-000000000101";
const plan = {
  name: "Five visits",
  kind: "package",
  priceCents: 5000,
  includedUses: 5,
  serviceIds: [serviceId],
  idempotencyKey: "benefit-plan-123",
};
test("packages define positive paid uses and cannot specify a recurring billing interval", () => {
  expect(createBenefitPlanSchema.safeParse(plan).success).toBe(true);
  expect(createBenefitPlanSchema.safeParse({ ...plan, includedUses: 0 }).success).toBe(false);
  expect(createBenefitPlanSchema.safeParse({ ...plan, periodMonths: 1 }).success).toBe(false);
  expect(createBenefitPlanSchema.safeParse({ ...plan, priceCents: 2 }).success).toBe(false);
});
test("membership periods support included visits, membership discounts or both", () => {
  expect(
    createBenefitPlanSchema.safeParse({ ...plan, kind: "membership", periodMonths: 1 }).success,
  ).toBe(true);
  expect(
    createBenefitPlanSchema.safeParse({
      ...plan,
      kind: "membership",
      periodMonths: 1,
      includedUses: 0,
      discountBasisPoints: 1000,
    }).success,
  ).toBe(true);
  expect(
    createBenefitPlanSchema.safeParse({ ...plan, kind: "membership", periodMonths: 0 }).success,
  ).toBe(false);
  expect(
    createBenefitPlanSchema.safeParse({
      ...plan,
      kind: "membership",
      periodMonths: 1,
      includedUses: 0,
      discountBasisPoints: 0,
    }).success,
  ).toBe(false);
});
test("entitlement purchases use a catalog plan and never accept caller prices or unit counts", () => {
  expect(
    benefitPurchaseSchema.safeParse({ planId: serviceId, idempotencyKey: "purchase-123" }).success,
  ).toBe(true);
  expect(
    benefitPurchaseSchema.safeParse({
      planId: serviceId,
      priceCents: 1,
      includedUses: 999,
      idempotencyKey: "purchase-123",
    }).success,
  ).toBe(false);
});
