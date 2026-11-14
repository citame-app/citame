import { describe, expect, test } from "bun:test";
import { localDayBounds, minutesIntoLocalDay, startOfWeek, weekDates, zonedInstant } from "./zoned";

const BA = "America/Argentina/Buenos_Aires"; // UTC-3, no DST
const NY = "America/New_York";

describe("zonedInstant", () => {
  test("converts salon wall-clock time to a UTC instant", () => {
    expect(zonedInstant("2026-03-09", "09:00", BA)).toBe("2026-03-09T12:00:00.000Z");
    expect(zonedInstant("2026-03-09", "23:30", BA)).toBe("2026-03-10T02:30:00.000Z");
  });

  test("respects DST on both sides of a change", () => {
    expect(zonedInstant("2026-03-07", "12:00", NY)).toBe("2026-03-07T17:00:00.000Z"); // EST
    expect(zonedInstant("2026-03-09", "12:00", NY)).toBe("2026-03-09T16:00:00.000Z"); // EDT
  });
});

describe("localDayBounds", () => {
  test("a local day is [00:00, next 00:00) in the salon timezone", () => {
    expect(localDayBounds("2026-03-09", BA)).toEqual({
      from: "2026-03-09T03:00:00.000Z",
      to: "2026-03-10T03:00:00.000Z",
    });
  });

  test("a DST day is 23 hours long", () => {
    const { from, to } = localDayBounds("2026-03-08", NY);
    expect((Date.parse(to) - Date.parse(from)) / 3_600_000).toBe(23);
  });
});

describe("minutesIntoLocalDay", () => {
  test("counts minutes since local midnight", () => {
    expect(minutesIntoLocalDay("2026-03-09T12:30:00.000Z", BA)).toBe(9 * 60 + 30);
  });
});

describe("weeks", () => {
  test("weeks start on Monday", () => {
    expect(startOfWeek("2026-03-11")).toBe("2026-03-09"); // Wednesday
    expect(startOfWeek("2026-03-09")).toBe("2026-03-09");
    expect(startOfWeek("2026-03-15")).toBe("2026-03-09"); // Sunday
  });

  test("weekDates lists seven consecutive days", () => {
    expect(weekDates("2026-03-11")).toEqual([
      "2026-03-09",
      "2026-03-10",
      "2026-03-11",
      "2026-03-12",
      "2026-03-13",
      "2026-03-14",
      "2026-03-15",
    ]);
  });
});
