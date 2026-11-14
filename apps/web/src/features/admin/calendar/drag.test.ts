import { describe, expect, test } from "bun:test";
import { dropTarget, exceedsDragThreshold } from "./drag";

describe("exceedsDragThreshold", () => {
  test("a click is not a drag until the pointer moves a few pixels", () => {
    expect(exceedsDragThreshold({ x: 10, y: 10 }, { x: 12, y: 11 })).toBe(false);
    expect(exceedsDragThreshold({ x: 10, y: 10 }, { x: 10, y: 20 })).toBe(true);
  });
});

describe("dropTarget", () => {
  const columns = [
    { staffId: "a", date: "2026-03-09", left: 0, right: 200, top: 100, bottom: 1000 },
    { staffId: "b", date: "2026-03-09", left: 200, right: 400, top: 100, bottom: 1000 },
  ];
  const grid = { startHour: 8, pxPerMinute: 1, granularity: 15 };

  test("finds the column under the pointer and snaps the time from the grabbed offset", () => {
    // pointer 130px below the column top, grabbed 10px below the block's top => block top at 120px = 120 min after 08:00
    expect(dropTarget({ x: 250, y: 230 }, 10, columns, grid)).toEqual({
      staffId: "b",
      date: "2026-03-09",
      minutesOfDay: 8 * 60 + 120,
    });
  });

  test("snaps to the slot grid", () => {
    expect(dropTarget({ x: 50, y: 100 + 67 }, 0, columns, grid)?.minutesOfDay).toBe(8 * 60 + 60);
  });

  test("outside every column there is no target", () => {
    expect(dropTarget({ x: 900, y: 300 }, 0, columns, grid)).toBeNull();
  });
});
