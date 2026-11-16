import { expect, test } from "bun:test";
import { computeAvailability } from "./compute";
import { bookingViolations } from "./rules";
import { workingWindows } from "./windows";

const input = {
  timeZone: "Europe/Madrid",
  now: new Date("2026-03-01T09:00:00Z"),
  minNoticeMinutes: 0,
  maxDaysAhead: 90,
  workingHours: [{ weekday: 1, start: "09:00", end: "18:00" }],
  timeOff: [],
};
const dateHours = [{ date: "2026-03-09", ranges: [{ start: "12:00", end: "14:00" }] }];
test("one date replaces the weekly schedule for booking and availability and does not leak into another week", () => {
  const book = (hour: string, date = "2026-03-09", datedWorkingHours = dateHours) =>
    bookingViolations({
      ...input,
      startsAt: new Date(`${date}T${hour}:00Z`),
      endsAt: new Date(new Date(`${date}T${hour}:00Z`).getTime() + 3600000),
      datedWorkingHours,
    });
  expect(book("08:00")).toEqual(["outside_working_hours"]);
  expect(book("11:00")).toEqual([]);
  expect(book("08:00", "2026-03-16")).toEqual([]);
  expect(book("11:00", "2026-03-09", [{ date: "2026-03-09", ranges: [] }])).toEqual([
    "outside_working_hours",
  ]);
  const available = computeAvailability({
    date: "2026-03-09",
    ...input,
    granularityMinutes: 60,
    blockMinutes: 60,
    staff: [
      {
        staffId: "a",
        workingHours: input.workingHours,
        timeOff: [],
        appointments: [],
        datedWorkingHours: dateHours,
      },
    ],
  });
  expect(available.map((slot) => slot.startsAt.toISOString())).toEqual([
    "2026-03-09T11:00:00.000Z",
    "2026-03-09T12:00:00.000Z",
  ]);
});
test("a dated shift opens a weekend without bypassing time off, notice or existing appointments", () => {
  const available = computeAvailability({
    date: "2026-03-14",
    ...input,
    granularityMinutes: 60,
    blockMinutes: 60,
    staff: [
      {
        staffId: "a",
        workingHours: input.workingHours,
        datedWorkingHours: [{ date: "2026-03-14", ranges: [{ start: "09:00", end: "12:00" }] }],
        timeOff: [{ start: new Date("2026-03-14T09:00Z"), end: new Date("2026-03-14T10:00Z") }],
        appointments: [
          { start: new Date("2026-03-14T10:00Z"), end: new Date("2026-03-14T11:00Z") },
        ],
      },
    ],
  });
  expect(available.map((slot) => slot.startsAt.toISOString())).toEqual([
    "2026-03-14T08:00:00.000Z",
  ]);
});

test("the calendar draws the same dated windows as availability, including explicit closed dates", () => {
  const windows = workingWindows({
    from: new Date("2026-03-09T00:00Z"),
    to: new Date("2026-03-17T00:00Z"),
    timeZone: input.timeZone,
    staff: [
      {
        staffId: "a",
        workingHours: input.workingHours,
        datedWorkingHours: [
          { date: "2026-03-09", ranges: [] },
          { date: "2026-03-14", ranges: [{ start: "12:00", end: "14:00" }] },
        ],
      },
    ],
  });
  expect(
    windows.map((window) => [window.startsAt.toISOString(), window.endsAt.toISOString()]),
  ).toEqual([
    ["2026-03-14T11:00:00.000Z", "2026-03-14T13:00:00.000Z"],
    ["2026-03-16T08:00:00.000Z", "2026-03-16T17:00:00.000Z"],
  ]);
});
