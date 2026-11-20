import { describe, expect, test } from "bun:test";
import { zonedInstant } from "~/lib/zoned";
import {
  availableActions,
  gridHours,
  layoutBlocks,
  minutesToOffset,
  monthDates,
  nowMarkerMinutes,
  offsetToSnappedMinutes,
  rangeFor,
  statusAppearance,
} from "./logic";

const BA = "America/Argentina/Buenos_Aires";
const at = (hhmm: string) => zonedInstant("2026-03-09", hhmm, BA);
test("an imported consultation appointment offers no mutations even to an owner in other views", () => {
  expect(
    availableActions(
      "owner",
      {
        status: "booked",
        startsAt: at("10:00"),
        staffId: "synthetic",
        sourceCopy: { readOnly: true },
      },
      new Date(at("11:00")),
      null,
    ),
  ).toEqual({ complete: false, noShow: false, cancel: false, reschedule: false });
});

describe("rangeFor", () => {
  test("a day is one local day, a week starts on Monday", () => {
    expect(rangeFor("day", "2026-03-11", BA)).toEqual({
      dates: ["2026-03-11"],
      from: "2026-03-11T03:00:00.000Z",
      to: "2026-03-12T03:00:00.000Z",
    });
    const week = rangeFor("week", "2026-03-11", BA);
    expect(week.dates[0]).toBe("2026-03-09");
    expect(week.dates).toHaveLength(7);
    expect(week.to).toBe("2026-03-16T03:00:00.000Z");
  });
});

test("month ranges include full weeks and remain valid over Madrid daylight saving time", () => {
  expect(monthDates("2026-02-10")).toHaveLength(35);
  const august = rangeFor("month", "2026-08-15", "Europe/Madrid");
  expect(august.dates).toHaveLength(42);
  expect(august.dates[0]).toBe("2026-07-27");
  expect(august.dates.at(-1)).toBe("2026-09-06");
  const october = rangeFor("month", "2028-10-15", "Europe/Madrid");
  expect(october.dates).toHaveLength(42);
  expect(Date.parse(october.to) - Date.parse(october.from)).toBe(42 * 86400000 + 3600000);
  expect(rangeFor("list", "2026-03-11", BA).dates[0]).toBe("2026-03-11");
});

test("short appointments use separate visual lanes without changing their duration", () => {
  const blocks = layoutBlocks(
    [
      { id: "first", startsAt: at("10:00"), endsAt: at("10:05") },
      { id: "second", startsAt: at("10:05"), endsAt: at("10:10") },
    ],
    BA,
    480,
    "2026-03-09",
    15,
  );
  expect(blocks.map((block) => block.durationMinutes)).toEqual([5, 5]);
  expect(blocks.map((block) => block.lane)).toEqual([0, 1]);
  expect(blocks.map((block) => block.lanes)).toEqual([2, 2]);
});

describe("layoutBlocks", () => {
  test("places blocks by minutes from the grid start", () => {
    const [block] = layoutBlocks(
      [{ id: "a", startsAt: at("10:00"), endsAt: at("11:00") }],
      BA,
      8 * 60,
    );
    expect(block).toMatchObject({
      id: "a",
      startMinutes: 120,
      durationMinutes: 60,
      lane: 0,
      lanes: 1,
    });
  });

  test("overlapping blocks share the width in lanes", () => {
    const blocks = layoutBlocks(
      [
        { id: "a", startsAt: at("10:00"), endsAt: at("11:00") },
        { id: "b", startsAt: at("10:30"), endsAt: at("11:30") },
        { id: "c", startsAt: at("12:00"), endsAt: at("12:30") },
      ],
      BA,
      8 * 60,
    );
    const byId = Object.fromEntries(blocks.map((b) => [b.id, b]));
    expect([byId.a?.lane, byId.b?.lane]).toEqual([0, 1]);
    expect([byId.a?.lanes, byId.b?.lanes]).toEqual([2, 2]);
    expect([byId.c?.lane, byId.c?.lanes]).toEqual([0, 1]);
  });

  test("clamps a block that starts before the grid", () => {
    const [block] = layoutBlocks(
      [{ id: "a", startsAt: at("07:00"), endsAt: at("09:00") }],
      BA,
      8 * 60,
    );
    expect(block).toMatchObject({ startMinutes: 0, durationMinutes: 60 });
  });
});

describe("gridHours", () => {
  test("defaults to the business day", () => {
    expect(gridHours([], [], BA)).toEqual({ startHour: 8, endHour: 20 });
  });

  test("grows to cover working windows and appointments", () => {
    expect(
      gridHours(
        [{ startsAt: at("07:30"), endsAt: at("15:00") }],
        [{ startsAt: at("19:00"), endsAt: at("21:15") }],
        BA,
      ),
    ).toEqual({ startHour: 7, endHour: 22 });
  });
});

describe("pointer geometry", () => {
  test("minutes and pixels convert both ways", () => {
    expect(minutesToOffset(90, 1.2)).toBe(108);
    expect(offsetToSnappedMinutes(108, 1.2, 15)).toBe(90);
  });

  test("snaps to the salon grid", () => {
    expect(offsetToSnappedMinutes(59, 1, 15)).toBe(60);
    expect(offsetToSnappedMinutes(52, 1, 15)).toBe(45);
    expect(offsetToSnappedMinutes(-10, 1, 15)).toBe(0);
  });
});

describe("nowMarkerMinutes", () => {
  test("is the minute of day for today, null for other days", () => {
    const now = new Date("2026-03-09T15:20:00Z");
    expect(nowMarkerMinutes(now, "2026-03-09", BA)).toBe(12 * 60 + 20);
    expect(nowMarkerMinutes(now, "2026-03-10", BA)).toBeNull();
  });
});

describe("statusAppearance", () => {
  test("every status has a label key and an icon, never color alone", () => {
    for (const status of ["booked", "completed", "cancelled", "no_show"] as const) {
      const look = statusAppearance(status);
      expect(look.icon.length).toBeGreaterThan(0);
      expect(look.labelKey).toBe(`calendar.status.${status}`);
    }
    expect(
      new Set(
        ["booked", "completed", "cancelled", "no_show"].map(
          (s) => statusAppearance(s as "booked").icon,
        ),
      ).size,
    ).toBe(4);
  });
});

describe("availableActions", () => {
  const started = {
    status: "booked",
    startsAt: "2026-03-09T12:00:00.000Z",
    staffId: "s1",
  } as const;
  const now = new Date("2026-03-09T13:00:00Z");

  test("a booked appointment that has started can be completed or marked no-show", () => {
    const actions = availableActions("staff", { ...started }, now, "s1");
    expect(actions).toMatchObject({ complete: true, noShow: true, cancel: true, reschedule: true });
  });

  test("outcomes wait until the start time (409 invalid_state otherwise)", () => {
    const future = { ...started, startsAt: "2026-03-09T18:00:00.000Z" };
    const actions = availableActions("owner", future, now, null);
    expect(actions).toMatchObject({ complete: false, noShow: false, cancel: true });
    expect(actions.completeBlockedReason).toBe("notStarted");
  });

  test("only the owner corrects a finished outcome", () => {
    const done = { ...started, status: "completed" } as const;
    expect(availableActions("owner", done, now, null)).toMatchObject({
      noShow: true,
      complete: false,
      cancel: false,
      reschedule: false,
    });
    expect(availableActions("staff", done, now, "s1")).toMatchObject({
      noShow: false,
      complete: false,
    });
  });

  test("a cancelled appointment is terminal", () => {
    const cancelled = { ...started, status: "cancelled" } as const;
    expect(availableActions("owner", cancelled, now, null)).toMatchObject({
      complete: false,
      noShow: false,
      cancel: false,
      reschedule: false,
    });
  });

  test("staff cannot act on another calendar", () => {
    expect(availableActions("staff", { ...started }, now, "other")).toMatchObject({
      complete: false,
      cancel: false,
      reschedule: false,
    });
  });
});
