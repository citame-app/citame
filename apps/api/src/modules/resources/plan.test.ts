import { expect, test } from "bun:test";
import { allocateResourceUnits, createResourceCapacityCalendar, repackResourceUnits } from "./plan";

test("adjacent service windows can reuse the same unit while overlapping occupied time consumes it", () => {
  expect(
    allocateResourceUnits(
      2,
      [
        { position: 0, start: 0, end: 60, quantity: 1 },
        { position: 1, start: 60, end: 120, quantity: 1 },
      ],
      [{ unitIndex: 0, start: 0, end: 60 }],
    ),
  ).toEqual([
    { position: 0, unitIndex: 1 },
    { position: 1, unitIndex: 0 },
  ]);
  expect(
    allocateResourceUnits(
      1,
      [{ position: 0, start: 30, end: 90, quantity: 1 }],
      [{ unitIndex: 0, start: 0, end: 60 }],
    ),
  ).toBeNull();
});
test("a multi-unit requirement needs that many complete free windows, including cleanup time", () => {
  expect(
    allocateResourceUnits(
      3,
      [{ position: 0, start: 0, end: 60, quantity: 2 }],
      [
        { unitIndex: 0, start: 45, end: 60 },
        { unitIndex: 1, start: 60, end: 120 },
      ],
    ),
  ).toEqual([
    { position: 0, unitIndex: 1 },
    { position: 0, unitIndex: 2 },
  ]);
  expect(
    allocateResourceUnits(
      2,
      [{ position: 0, start: 0, end: 60, quantity: 2 }],
      [{ unitIndex: 0, start: 45, end: 60 }],
    ),
  ).toBeNull();
});
test("reducing capacity repacks interchangeable units instead of keeping a meaningless old unit number", () => {
  expect(
    repackResourceUnits(1, [
      { id: "first", start: 0, end: 60 },
      { id: "second", start: 60, end: 120 },
    ]),
  ).toEqual([
    { id: "first", unitIndex: 0 },
    { id: "second", unitIndex: 0 },
  ]);
  expect(
    repackResourceUnits(1, [
      { id: "first", start: 0, end: 60 },
      { id: "second", start: 30, end: 90 },
    ]),
  ).toBeNull();
});

test("pooled capacity is still available when interchangeable future unit assignments are fragmented", () => {
  const available = createResourceCapacityCalendar(2, [
    { unitIndex: 0, start: 0, end: 5 },
    { unitIndex: 1, start: 5, end: 10 },
  ]);
  expect(available?.([{ position: 0, start: 0, end: 10, quantity: 1 }])).toBe(true);
  expect(available?.([{ position: 0, start: 0, end: 10, quantity: 2 }])).toBe(false);
});
test("capacity repacking preserves units already in use while moving only future allocations", () => {
  expect(
    repackResourceUnits(
      2,
      [{ id: "future", start: 5, end: 10 }],
      [{ unitIndex: 0, start: -5, end: 10 }],
    ),
  ).toEqual([{ id: "future", unitIndex: 1 }]);
  expect(
    repackResourceUnits(
      1,
      [{ id: "future", start: 5, end: 10 }],
      [{ unitIndex: 0, start: -5, end: 10 }],
    ),
  ).toBeNull();
});
