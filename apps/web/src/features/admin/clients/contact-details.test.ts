import { expect, test } from "bun:test";
import { contactDraft, parseContactDraft } from "./contact-details";

test("birthday can omit the year, respects leap years and requires month and day together", () => {
  expect(parseContactDraft({ ...contactDraft(), month: "2", day: "29" }).success).toBe(true);
  expect(
    parseContactDraft({ ...contactDraft(), month: "2", day: "29", year: "2001" }).success,
  ).toBe(false);
  expect(parseContactDraft({ ...contactDraft(), month: "4", day: "31" }).success).toBe(false);
  expect(parseContactDraft({ ...contactDraft(), month: "4" }).success).toBe(false);
});
test("a profile discount is exact basis points and cannot exceed the receipt", () => {
  const parsed = parseContactDraft({ ...contactDraft(), discount: "12,50" });
  expect(parsed.success && parsed.data.discountBasisPoints).toBe(1250);
  expect(parseContactDraft({ ...contactDraft(), discount: "100.01" }).success).toBe(false);
  expect(parseContactDraft({ ...contactDraft(), discount: "12.345" }).success).toBe(false);
});
