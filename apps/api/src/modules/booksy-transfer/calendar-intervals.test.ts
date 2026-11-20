import { expect, test } from "bun:test";
import { projectCalendarIntervals } from "./calendar-intervals";

const at = (hour: number, day: number) => ({
  at: `2026-11-17T${hour}:00:00Z`,
  ref: "7",
  start: `2026-11-${day}T10:00:00`,
  end: `2026-11-${day}T11:00:00`,
  row: {
    id: 7,
    booked_from: `2026-11-${day}T10:00:00`,
    booked_till: `2026-11-${day}T11:00:00`,
  },
});

test("a daily capture cannot overwrite a more recent weekly observation on another date", () => {
  const oldDaily = at(12, 18);
  const movedWeekly = at(13, 19);
  for (const captures of [
    [oldDaily, movedWeekly],
    [movedWeekly, oldDaily],
  ]) {
    expect(projectCalendarIntervals(captures, captures).get("7")).toEqual(movedWeekly);
  }
});

test("when a moved booking disappears from a refresh its older date is not resurrected", () => {
  const oldDate = at(12, 18);
  const newDate = at(13, 19);
  // A later empty observation of the 19th leaves only the old date in the
  // selected daily records. The earlier move is still in the archive.
  expect(projectCalendarIntervals([oldDate], [oldDate, newDate]).size).toBe(0);
});

test("conflicting observations at the same instant fail regardless of input order", () => {
  const first = at(12, 18);
  const second = { ...at(12, 19), at: "2026-11-17T13:00:00+01:00" };
  for (const captures of [
    [first, second],
    [second, first],
  ]) {
    expect(() => projectCalendarIntervals(captures, captures)).toThrow("Simultaneous");
  }
});

test("a moved staff block uses the new day and cannot fall back to the old slot", () => {
  const block = (hour: number, day: number) => {
    const old = at(hour, day);
    return {
      ...old,
      ref: "staff-block-7",
      row: { reserved_from: old.start, reserved_till: old.end, resources: [{ id: 10 }] },
    };
  };
  const old = block(12, 18);
  const moved = block(15, 19);
  expect(projectCalendarIntervals([moved, old], [old, moved]).get(old.ref)).toEqual(moved);
  expect(projectCalendarIntervals([old], [moved, old]).size).toBe(0);
});
