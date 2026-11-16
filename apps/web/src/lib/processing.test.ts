import { expect, test } from "bun:test";
import { processingRanges } from "./processing";

test("processing annotations follow the frozen work plan, independent of a changed service description", () => {
  expect(
    processingRanges({
      startsAt: "2026-03-09T12:00:00Z",
      endsAt: "2026-03-09T13:40:00Z",
      services: [],
      workWindows: [
        { offsetMinutes: 0, endOffsetMinutes: 30 },
        { offsetMinutes: 60, endOffsetMinutes: 100 },
      ],
    }),
  ).toEqual([
    {
      startsAt: "2026-03-09T12:30:00.000Z",
      endsAt: "2026-03-09T13:00:00.000Z",
      offsetMinutes: 30,
      minutes: 30,
    },
  ]);
});
test("legacy snapshots without a plan retain their own processing metadata and buffers", () => {
  expect(
    processingRanges({
      startsAt: "2026-03-09T12:00:00Z",
      endsAt: "2026-03-09T14:10:00Z",
      services: [
        { durationMinutes: 20, bufferMinutes: 10 },
        {
          durationMinutes: 90,
          bufferMinutes: 10,
          processing: { startsAfterMinutes: 30, minutes: 30 },
        },
      ],
    }),
  ).toEqual([
    {
      startsAt: "2026-03-09T13:00:00.000Z",
      endsAt: "2026-03-09T13:30:00.000Z",
      offsetMinutes: 60,
      minutes: 30,
    },
  ]);
});
