import { expect, test } from "bun:test";
import { promotionInputSchema } from "./rewards";

const base = {
  code: "MORNINGS",
  name: "Morning appointments",
  kind: "percent",
  value: 1000,
  eligibleKinds: ["service"],
};
const timing = { weekdays: [1, 2, 3, 4, 5], startMinute: 600, endMinute: 780, lastMinuteHours: 24 };
test("timed service promotions retain reviewed weekdays, local start times and booking lead limit", () => {
  expect(promotionInputSchema.parse({ ...base, timing })).toHaveProperty("timing", timing);
});
test("timed terms reject ambiguous windows, duplicate days, fractional hours and non-visit sales", () => {
  for (const invalid of [
    { ...timing, weekdays: [] },
    { ...timing, weekdays: [1, 1] },
    { ...timing, weekdays: [0] },
    { ...timing, weekdays: [8] },
    { ...timing, startMinute: 780 },
    { ...timing, endMinute: 1441 },
    { ...timing, lastMinuteHours: 1.5 },
    { ...timing, lastMinuteHours: 169 },
  ])
    expect(promotionInputSchema.safeParse({ ...base, timing: invalid }).success).toBe(false);
  expect(
    promotionInputSchema.safeParse({ ...base, timing, eligibleKinds: ["service", "product"] })
      .success,
  ).toBe(false);
});
test("legacy promotions preserve their original normalized payload", () => {
  expect(promotionInputSchema.parse(base)).not.toHaveProperty("timing");
});
