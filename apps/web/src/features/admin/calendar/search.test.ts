import { describe, expect, test } from "bun:test";
import { shiftDate, validateCalendarSearch } from "./search";

const TODAY = "2026-03-09";
const ID = "0198f5a0-7b1c-7000-8000-000000000201";

describe("validateCalendarSearch", () => {
  test("defaults to the day view of today", () => {
    expect(validateCalendarSearch({}, TODAY)).toEqual({ view: "day", date: TODAY });
  });

  test("keeps valid values", () => {
    expect(validateCalendarSearch({ view: "week", date: "2026-04-01", staff: ID }, TODAY)).toEqual({
      view: "week",
      date: "2026-04-01",
      staff: ID,
    });
  });

  test("keeps a comma separated team filter and drops invalid ids", () => {
    const other = "0198f5a0-7b1c-7000-8000-000000000202";
    expect(validateCalendarSearch({ staff: `${ID},${other}` }, TODAY).staff).toBe(`${ID},${other}`);
    expect(validateCalendarSearch({ staff: `${ID},nope,${ID}` }, TODAY).staff).toBe(ID);
  });

  test("drops junk instead of failing", () => {
    expect(
      validateCalendarSearch({ view: "unknown", date: "tomorrow", staff: "x" }, TODAY),
    ).toEqual({
      view: "day",
      date: TODAY,
    });
    expect(validateCalendarSearch({ date: "2026-02-30" }, TODAY).date).toBe(TODAY);
  });
});

describe("shiftDate", () => {
  test("moves months without overflowing February and lists by seven days", () => {
    expect(shiftDate("2026-01-31", "month", 1)).toBe("2026-02-28");
    expect(shiftDate("2024-01-31", "month", 1)).toBe("2024-02-29");
    expect(shiftDate("2026-01-15", "month", -1)).toBe("2025-12-15");
    expect(shiftDate("2026-03-09", "list", 1)).toBe("2026-03-16");
  });
  test("moves by a day in the day view and by a week in the week view", () => {
    expect(shiftDate("2026-03-09", "day", 1)).toBe("2026-03-10");
    expect(shiftDate("2026-03-09", "day", -1)).toBe("2026-03-08");
    expect(shiftDate("2026-03-09", "week", 1)).toBe("2026-03-16");
    expect(shiftDate("2026-03-01", "week", -1)).toBe("2026-02-22");
  });
});

test("all four views and the working-team filter survive URL validation", () => {
  for (const view of ["day", "week", "month", "list"] as const) {
    expect(validateCalendarSearch({ view, staff: ID, working: "true" }, TODAY)).toEqual({
      view,
      date: TODAY,
      staff: ID,
      working: true,
    });
  }
  expect(validateCalendarSearch({ working: "false" }, TODAY).working).toBeUndefined();
});
