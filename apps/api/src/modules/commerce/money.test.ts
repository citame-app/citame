import { expect, test } from "bun:test";
import { allocateDiscount, multiplyDivide } from "./money";

test("money ratios keep integer cents exact at the largest supported sale", () => {
  expect(multiplyDivide(999999999, 1999999995, 1999999997)).toBe(999999997);
  expect(allocateDiscount([1999999995, 2], 999999999)).toEqual([999999997, 2]);
});
test("allocation preserves the total and never discounts a line below zero", () => {
  expect(allocateDiscount([0, 1, 1, 1], 2)).toEqual([0, 0, 1, 1]);
});
