import { expect, test } from "bun:test";
import {
  dateShiftDaySchema,
  dateShiftInputSchema,
  dateShiftRangesSchema,
  expandShiftTargets,
} from "./date-shifts";

test("dated shifts accept a closed day, touching ranges and explicit restoration of weekly hours", () => {
  expect(dateShiftRangesSchema.safeParse([]).success).toBe(true);
  expect(
    dateShiftRangesSchema.safeParse([
      { startTime: "09:00", endTime: "12:00" },
      { startTime: "12:00", endTime: "14:00" },
    ]).success,
  ).toBe(true);
  expect(
    dateShiftInputSchema.safeParse({
      mode: "edit",
      changes: [{ date: "2026-03-09", ranges: null }],
    }).success,
  ).toBe(true);
  for (const ranges of [
    [{ startTime: "10:00", endTime: "09:00" }],
    [
      { startTime: "09:00", endTime: "12:00" },
      { startTime: "11:30", endTime: "14:00" },
    ],
    [{ startTime: "24:00", endTime: "24:30" }],
  ])
    expect(dateShiftRangesSchema.safeParse(ranges).success).toBe(false);
});

test("inherited weekly schedules retain their supported ranges even when a custom date has a smaller editing limit", () => {
  const ranges = Array.from({ length: 9 }, (_, index) => ({
    startTime: `${String(index).padStart(2, "0")}:00`,
    endTime: `${String(index + 1).padStart(2, "0")}:00`,
  }));
  expect(
    dateShiftDaySchema.safeParse({
      date: "2026-03-09",
      version: 0,
      ranges: null,
      effectiveRanges: ranges,
    }).success,
  ).toBe(true);
  expect(dateShiftRangesSchema.safeParse(ranges).success).toBe(false);
});
test("copying preserves calendar dates across months and leap days and rejects ambiguous overlapping target batches", () => {
  expect(
    expandShiftTargets({
      mode: "copy",
      sourceFrom: "2028-02-28",
      days: 3,
      targetStarts: ["2028-03-06"],
    }),
  ).toEqual([
    { source: "2028-02-28", target: "2028-03-06" },
    { source: "2028-02-29", target: "2028-03-07" },
    { source: "2028-03-01", target: "2028-03-08" },
  ]);
  for (const input of [
    { mode: "copy", sourceFrom: "2026-03-09", days: 7, targetStarts: ["2026-03-16", "2026-03-17"] },
    { mode: "copy", sourceFrom: "2026-03-09", days: 7, targetStarts: ["2026-03-10"] },
    { mode: "copy", sourceFrom: "2026-03-09", days: 8, targetStarts: ["2026-03-16"] },
    { mode: "copy", sourceFrom: "2026-02-30", days: 1, targetStarts: ["2026-03-16"] },
    {
      mode: "edit",
      changes: [
        { date: "2026-03-09", ranges: [] },
        { date: "2026-03-09", ranges: null },
      ],
    },
  ])
    expect(dateShiftInputSchema.safeParse(input).success).toBe(false);
});
