import { expect, test } from "bun:test";
import { seriesStartsAt } from "./series-dates";

test("weekly recurrence keeps the salon wall-clock time across a DST boundary", () => {
  expect(
    seriesStartsAt(
      { startsAt: "2026-03-23T08:00:00.000Z", cadence: "weekly", interval: 1, count: 3 },
      "Europe/Madrid",
    ),
  ).toEqual(["2026-03-23T08:00:00.000Z", "2026-03-30T07:00:00.000Z", "2026-04-06T07:00:00.000Z"]);
});
test("monthly dates use the original day instead of drifting after a shorter month", () => {
  expect(
    seriesStartsAt(
      { startsAt: "2027-01-31T08:00:00.000Z", cadence: "monthly", interval: 1, count: 3 },
      "Europe/Madrid",
    ),
  ).toEqual(["2027-01-31T08:00:00.000Z", "2027-02-28T08:00:00.000Z", "2027-03-31T07:00:00.000Z"]);
});
test("nonexistent or ambiguous recurrence times require an explicit different time", () => {
  expect(() =>
    seriesStartsAt(
      { startsAt: "2026-03-22T01:30:00.000Z", cadence: "weekly", interval: 1, count: 2 },
      "Europe/Madrid",
    ),
  ).toThrow();
  expect(() =>
    seriesStartsAt(
      { startsAt: "2026-10-18T00:30:00.000Z", cadence: "weekly", interval: 1, count: 2 },
      "Europe/Madrid",
    ),
  ).toThrow();
});
