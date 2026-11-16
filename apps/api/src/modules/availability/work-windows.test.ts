import { expect, test } from "bun:test";
import { createStaffCapacityCalendar, serviceWorkWindows } from "./work-windows";

test("processing releases only its middle interval, retains cleanup and skips price-only extras", () => {
  expect(
    serviceWorkWindows([
      { durationMinutes: 45, bufferMinutes: 15 },
      { durationMinutes: 0, bufferMinutes: 0 },
      {
        durationMinutes: 90,
        bufferMinutes: 10,
        processing: { startsAfterMinutes: 20, minutes: 40 },
      },
    ]),
  ).toEqual([
    { offsetMinutes: 0, endOffsetMinutes: 80 },
    { offsetMinutes: 120, endOffsetMinutes: 160 },
  ]);
});
test("ordinary sequences remain one blocked window and processing needs work before and after", () => {
  expect(
    serviceWorkWindows([
      { durationMinutes: 30, bufferMinutes: 5 },
      { durationMinutes: 45, bufferMinutes: 10 },
    ]),
  ).toEqual([{ offsetMinutes: 0, endOffsetMinutes: 90 }]);
  for (const processing of [
    { startsAfterMinutes: 0, minutes: 20 },
    { startsAfterMinutes: 20, minutes: 70 },
    { startsAfterMinutes: 20, minutes: -1 },
  ])
    expect(() =>
      serviceWorkWindows([{ durationMinutes: 90, bufferMinutes: 10, processing }]),
    ).toThrow();
});
test("capacity counts active work rather than client presence, including half-open boundaries", () => {
  const calendar = createStaffCapacityCalendar(1, [
    { start: 0, end: 20 },
    { start: 60, end: 90 },
  ]);
  expect(calendar([{ start: 20, end: 60 }])).toBe(true);
  expect(calendar([{ start: 19, end: 60 }])).toBe(false);
  expect(calendar([{ start: 20, end: 61 }])).toBe(false);
  const parallel = createStaffCapacityCalendar(2, [{ start: 0, end: 60 }]);
  expect(parallel([{ start: 0, end: 60 }])).toBe(true);
  expect(
    createStaffCapacityCalendar(2, [
      { start: 0, end: 60 },
      { start: 0, end: 60 },
    ])([{ start: 0, end: 60 }]),
  ).toBe(false);
});
test("fragmented old unit labels do not hide available pooled professional capacity", () => {
  expect(
    createStaffCapacityCalendar(2, [
      { start: 0, end: 20 },
      { start: 20, end: 40 },
    ])([{ start: 0, end: 40 }]),
  ).toBe(true);
  expect(
    createStaffCapacityCalendar(1, [{ start: 0, end: 20 }])([
      { start: 20, end: 30 },
      { start: 10, end: 15 },
    ]),
  ).toBe(false);
});
