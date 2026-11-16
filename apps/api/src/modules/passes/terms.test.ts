import { expect, test } from "bun:test";
import { allocatedUnits, membershipCycle, packageExpiry } from "./terms";

test("visit allocations preserve every cent, including non-divisible purchase values", () => {
  expect(allocatedUnits(1000, 3)).toEqual([334, 333, 333]);
  const values = allocatedUnits(999999999, 1000);
  expect(values.reduce((sum, value) => sum + value, 0)).toBe(999999999);
  expect(Math.max(...values) - Math.min(...values)).toBe(1);
  expect(allocatedUnits(1000, 0)).toEqual([]);
  expect(() => allocatedUnits(2, 3)).toThrow();
});
test("membership cycles retain the original month-end anchor and salon-local billing time across DST", () => {
  const anchor = new Date("2026-01-31T09:00:00.000Z");
  const february = membershipCycle(anchor, "Europe/Madrid", 1, 1);
  const march = membershipCycle(anchor, "Europe/Madrid", 1, 2);
  expect(february.startsAt.toISOString()).toBe("2026-02-28T09:00:00.000Z");
  expect(february.endsAt.toISOString()).toBe("2026-03-31T08:00:00.000Z");
  expect(march.startsAt.toISOString()).toBe("2026-03-31T08:00:00.000Z");
});
test("package validity counts calendar days in the salon timezone and may be unlimited", () => {
  const paidAt = new Date("2026-03-28T15:00:00.000Z");
  expect(packageExpiry(paidAt, "Europe/Madrid", 2)?.toISOString()).toBe("2026-03-30T14:00:00.000Z");
  expect(packageExpiry(paidAt, "Europe/Madrid", null)).toBeNull();
});
