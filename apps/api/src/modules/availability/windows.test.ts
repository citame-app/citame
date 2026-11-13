import { describe, expect, test } from "bun:test";
import { workingWindows } from "./windows";

const TZ = "America/Argentina/Buenos_Aires"; // UTC-3
const at = (iso: string) => new Date(iso);
const iso = (w: { staffId: string; startsAt: Date; endsAt: Date }) => [
  w.staffId,
  w.startsAt.toISOString(),
  w.endsAt.toISOString(),
];

const ana = { staffId: "ana", workingHours: [{ weekday: 1, start: "09:00", end: "18:00" }] };

describe("workingWindows", () => {
  test("resolves each recurring range on each matching date to instants", () => {
    const windows = workingWindows({
      // Mon 2026-03-09 00:00 local .. Mon 2026-03-16 00:00 local
      from: at("2026-03-09T03:00:00Z"),
      to: at("2026-03-16T03:00:00Z"),
      timeZone: TZ,
      staff: [ana],
    });
    expect(windows.map(iso)).toEqual([
      ["ana", "2026-03-09T12:00:00.000Z", "2026-03-09T21:00:00.000Z"],
    ]);
  });

  test("two Mondays in range give two windows; a split day gives two per day, in order", () => {
    const windows = workingWindows({
      from: at("2026-03-09T03:00:00Z"),
      to: at("2026-03-17T03:00:00Z"),
      timeZone: TZ,
      staff: [
        {
          staffId: "bea",
          workingHours: [
            { weekday: 1, start: "14:00", end: "18:00" },
            { weekday: 1, start: "09:00", end: "13:00" },
          ],
        },
      ],
    });
    expect(windows.map(iso)).toEqual([
      ["bea", "2026-03-09T12:00:00.000Z", "2026-03-09T16:00:00.000Z"],
      ["bea", "2026-03-09T17:00:00.000Z", "2026-03-09T21:00:00.000Z"],
      ["bea", "2026-03-16T12:00:00.000Z", "2026-03-16T16:00:00.000Z"],
      ["bea", "2026-03-16T17:00:00.000Z", "2026-03-16T21:00:00.000Z"],
    ]);
  });

  test("includes windows that merely overlap the range edges and drops the rest", () => {
    // Range 10:00..11:00 local on Monday cuts through the 09:00-18:00 window
    const overlapping = workingWindows({
      from: at("2026-03-09T13:00:00Z"),
      to: at("2026-03-09T14:00:00Z"),
      timeZone: TZ,
      staff: [ana],
    });
    expect(overlapping).toHaveLength(1);
    // Range entirely after closing
    expect(
      workingWindows({
        from: at("2026-03-09T21:00:00Z"),
        to: at("2026-03-09T23:00:00Z"),
        timeZone: TZ,
        staff: [ana],
      }),
    ).toEqual([]);
  });

  test("sorts by start, then staff, across several staff members", () => {
    const windows = workingWindows({
      from: at("2026-03-09T03:00:00Z"),
      to: at("2026-03-10T03:00:00Z"),
      timeZone: TZ,
      staff: [
        { staffId: "zed", workingHours: [{ weekday: 1, start: "09:00", end: "10:00" }] },
        { staffId: "ana", workingHours: [{ weekday: 1, start: "09:00", end: "10:00" }] },
        { staffId: "bea", workingHours: [{ weekday: 1, start: "08:00", end: "09:00" }] },
      ],
    });
    expect(windows.map((w) => w.staffId)).toEqual(["bea", "ana", "zed"]);
  });

  test("local dates and weekdays follow the salon timezone, DST included", () => {
    // New York springs forward Sun 2026-03-08: 09:00 local is 13:00Z (EDT) that day.
    const windows = workingWindows({
      from: at("2026-03-07T05:00:00Z"),
      to: at("2026-03-09T04:00:00Z"),
      timeZone: "America/New_York",
      staff: [{ staffId: "ny", workingHours: [{ weekday: 0, start: "09:00", end: "17:00" }] }],
    });
    expect(windows.map(iso)).toEqual([
      ["ny", "2026-03-08T13:00:00.000Z", "2026-03-08T21:00:00.000Z"],
    ]);
  });

  test("staff without hours yield nothing", () => {
    expect(
      workingWindows({
        from: at("2026-03-09T03:00:00Z"),
        to: at("2026-03-16T03:00:00Z"),
        timeZone: TZ,
        staff: [{ staffId: "off", workingHours: [] }],
      }),
    ).toEqual([]);
  });
});
