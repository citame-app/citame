import { expect, test } from "bun:test";
import { CreativeOverflowError, fitCreativeText, wrapCreativeText } from "./creative-layout";

test("text fitting stays within its measured bounds and never truncates offer terms", () => {
  const measure = (value: string, size: number) => (value.length * size) / 2;
  const result = fitCreativeText(
    "abcd efgh ijkl",
    100,
    48,
    { min: 12, max: 20, lineHeight: 1.2 },
    measure,
  );
  expect(result.lines).toEqual(["abcd efgh", "ijkl"]);
  expect(result.height).toBeLessThanOrEqual(48);
  expect(result.fontSize).toBe(20);
  expect(() =>
    fitCreativeText(
      "Complete promotion conditions must remain readable",
      30,
      12,
      { min: 12, max: 20, lineHeight: 1.2 },
      measure,
    ),
  ).toThrow(CreativeOverflowError);
});
test("wrapping a long token preserves combined emoji graphemes", () => {
  const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
  const measure = (value: string) => [...segmenter.segment(value)].length * 10;
  expect(wrapCreativeText("👩‍🔬👩‍🔬", 10, 12, measure)).toEqual(["👩‍🔬", "👩‍🔬"]);
});
