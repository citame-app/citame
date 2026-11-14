import { describe, expect, test } from "bun:test";
import {
  addRange,
  copyDay,
  emptyWeek,
  fromRanges,
  hoursEqual,
  toRanges,
  validateDay,
  zonedTimeOff,
} from "./hours";

describe("fromRanges / toRanges", () => {
  test("round-trips and sorts by weekday then start", () => {
    const ranges = [
      { weekday: 2, startTime: "14:00", endTime: "18:00" },
      { weekday: 1, startTime: "09:00", endTime: "13:00" },
      { weekday: 2, startTime: "09:00", endTime: "12:00" },
    ];
    const week = fromRanges(ranges);
    expect(week[1]).toEqual([{ start: "09:00", end: "13:00" }]);
    expect(week[2]).toEqual([
      { start: "09:00", end: "12:00" },
      { start: "14:00", end: "18:00" },
    ]);
    expect(week[0]).toEqual([]);
    expect(toRanges(week)).toEqual([
      { weekday: 1, startTime: "09:00", endTime: "13:00" },
      { weekday: 2, startTime: "09:00", endTime: "12:00" },
      { weekday: 2, startTime: "14:00", endTime: "18:00" },
    ]);
  });
});

describe("copyDay", () => {
  test("replaces the target days with a copy of the source day", () => {
    const week = {
      ...emptyWeek(),
      1: [{ start: "09:00", end: "17:00" }],
      3: [{ start: "10:00", end: "11:00" }],
    };
    const copied = copyDay(week, 1, [2, 3]);
    expect(copied[2]).toEqual([{ start: "09:00", end: "17:00" }]);
    expect(copied[3]).toEqual([{ start: "09:00", end: "17:00" }]);
    expect(copied[2]).not.toBe(week[1]);
    expect(week[3]).toEqual([{ start: "10:00", end: "11:00" }]);
  });
});

describe("addRange", () => {
  test("starts at 09:00-18:00 on an empty day, then after the last range", () => {
    expect(addRange([])).toEqual([{ start: "09:00", end: "18:00" }]);
    expect(addRange([{ start: "09:00", end: "12:00" }])).toEqual([
      { start: "09:00", end: "12:00" },
      { start: "13:00", end: "18:00" },
    ]);
  });
});

describe("validateDay", () => {
  test("reports inverted and overlapping ranges by index", () => {
    expect(validateDay([{ start: "10:00", end: "09:00" }])).toEqual([{ index: 0, kind: "order" }]);
    expect(
      validateDay([
        { start: "09:00", end: "12:00" },
        { start: "11:00", end: "13:00" },
      ]),
    ).toEqual([{ index: 1, kind: "overlap" }]);
  });

  test("touching ranges are fine, as in the API", () => {
    expect(
      validateDay([
        { start: "09:00", end: "12:00" },
        { start: "12:00", end: "13:00" },
      ]),
    ).toEqual([]);
  });
});

describe("hoursEqual", () => {
  test("compares schedules regardless of order", () => {
    const a = fromRanges([{ weekday: 1, startTime: "09:00", endTime: "17:00" }]);
    const b = fromRanges([{ weekday: 1, startTime: "09:00", endTime: "17:00" }]);
    expect(hoursEqual(a, b)).toBe(true);
    expect(hoursEqual(a, copyDay(a, 1, [2]))).toBe(false);
  });
});

describe("zonedTimeOff", () => {
  const BA = "America/Argentina/Buenos_Aires";
  test("builds instants from salon-local dates and times", () => {
    expect(
      zonedTimeOff(
        { startDate: "2026-03-10", startTime: "09:00", endDate: "2026-03-10", endTime: "12:00" },
        BA,
      ),
    ).toEqual({
      ok: true,
      startsAt: "2026-03-10T12:00:00.000Z",
      endsAt: "2026-03-10T15:00:00.000Z",
    });
  });

  test("rejects an end that is not after the start", () => {
    expect(
      zonedTimeOff(
        { startDate: "2026-03-10", startTime: "12:00", endDate: "2026-03-10", endTime: "12:00" },
        BA,
      ),
    ).toEqual({ ok: false, error: "endBeforeStart" });
  });

  test("rejects missing fields", () => {
    expect(
      zonedTimeOff(
        { startDate: "", startTime: "09:00", endDate: "2026-03-10", endTime: "10:00" },
        BA,
      ),
    ).toEqual({
      ok: false,
      error: "required",
    });
  });
});
