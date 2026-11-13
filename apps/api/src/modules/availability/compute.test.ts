import { describe, expect, test } from "bun:test";
import {
  type AvailabilityInput,
  computeAvailability,
  type StaffAvailabilityInput,
  totalBlockMinutes,
} from "./compute";

const BA = "America/Argentina/Buenos_Aires"; // UTC-3, no DST
const NY = "America/New_York";

// 2026-03-09 is a Monday. Buenos Aires local 09:00 == 12:00Z.
const MONDAY = "2026-03-09";
const NOW = new Date("2026-03-01T00:00:00Z");

function range(startIso: string, endIso: string) {
  return { start: new Date(startIso), end: new Date(endIso) };
}

function staff(overrides: Partial<StaffAvailabilityInput> = {}): StaffAvailabilityInput {
  return {
    staffId: "staff-a",
    workingHours: [{ weekday: 1, start: "09:00", end: "12:00" }],
    timeOff: [],
    appointments: [],
    ...overrides,
  };
}

function input(overrides: Partial<AvailabilityInput> = {}): AvailabilityInput {
  return {
    date: MONDAY,
    timeZone: BA,
    granularityMinutes: 30,
    minNoticeMinutes: 0,
    maxDaysAhead: 60,
    now: NOW,
    blockMinutes: 60,
    staff: [staff()],
    ...overrides,
  };
}

const starts = (slots: { startsAt: Date }[]) => slots.map((s) => s.startsAt.toISOString());

describe("totalBlockMinutes", () => {
  test("sums duration and buffer of every service", () => {
    expect(
      totalBlockMinutes([
        { durationMinutes: 45, bufferMinutes: 10 },
        { durationMinutes: 30, bufferMinutes: 5 },
      ]),
    ).toBe(90);
  });
});

describe("computeAvailability", () => {
  test("generates a granularity grid inside working hours", () => {
    const slots = computeAvailability(input());
    expect(starts(slots)).toEqual([
      "2026-03-09T12:00:00.000Z",
      "2026-03-09T12:30:00.000Z",
      "2026-03-09T13:00:00.000Z",
      "2026-03-09T13:30:00.000Z",
      "2026-03-09T14:00:00.000Z",
    ]);
    expect(slots[0]?.endsAt.toISOString()).toBe("2026-03-09T13:00:00.000Z");
    expect(slots[0]?.staffId).toBe("staff-a");
  });

  test("the whole block including buffer must fit in working hours", () => {
    const slots = computeAvailability(input({ blockMinutes: 70 }));
    expect(starts(slots).at(-1)).toBe("2026-03-09T13:30:00.000Z"); // 10:30 local, ends 11:40
    expect(slots).toHaveLength(4);
  });

  test("a block that exactly fills the range yields one slot; a longer one yields none", () => {
    expect(computeAvailability(input({ blockMinutes: 180 }))).toHaveLength(1);
    expect(computeAvailability(input({ blockMinutes: 181 }))).toHaveLength(0);
  });

  test("granularity larger than the leftover time does not produce partial slots", () => {
    const slots = computeAvailability(
      input({
        granularityMinutes: 45,
        blockMinutes: 30,
        staff: [staff({ workingHours: [{ weekday: 1, start: "09:00", end: "10:00" }] })],
      }),
    );
    expect(starts(slots)).toEqual(["2026-03-09T12:00:00.000Z"]);
  });

  test("time off removes overlapping slots but keeps adjacent ones", () => {
    const slots = computeAvailability(
      input({
        staff: [staff({ timeOff: [range("2026-03-09T13:00:00Z", "2026-03-09T14:00:00Z")] })],
      }),
    );
    // 10:00-11:00 local is off. 09:00-10:00 (adjacent) and 11:00-12:00 (adjacent) remain.
    expect(starts(slots)).toEqual(["2026-03-09T12:00:00.000Z", "2026-03-09T14:00:00.000Z"]);
  });

  test("existing appointments (buffer included) block overlapping slots", () => {
    const slots = computeAvailability(
      input({
        staff: [staff({ appointments: [range("2026-03-09T12:30:00Z", "2026-03-09T13:30:00Z")] })],
      }),
    );
    // Remaining: block starts at 13:30Z (10:30 local) and 14:00Z fits before 15:00Z.
    expect(starts(slots)).toEqual(["2026-03-09T13:30:00.000Z", "2026-03-09T14:00:00.000Z"]);
  });

  test("minimum notice hides slots that start too soon, boundary inclusive", () => {
    // now = 08:00 local; 90 min notice -> earliest 09:30 local (12:30Z).
    const slots = computeAvailability(
      input({ now: new Date("2026-03-09T11:00:00Z"), minNoticeMinutes: 90 }),
    );
    expect(starts(slots)[0]).toBe("2026-03-09T12:30:00.000Z");
  });

  test("max days ahead: the boundary day is bookable, the next one is not", () => {
    const now = new Date("2026-03-01T15:00:00Z"); // local date 2026-03-01
    expect(computeAvailability(input({ date: "2026-03-09", now, maxDaysAhead: 8 }))).not.toEqual(
      [],
    );
    expect(computeAvailability(input({ date: "2026-03-09", now, maxDaysAhead: 7 }))).toEqual([]);
  });

  test("past dates have no slots", () => {
    expect(computeAvailability(input({ now: new Date("2026-03-10T15:00:00Z") }))).toEqual([]);
  });

  test("days without working hours have no slots", () => {
    expect(computeAvailability(input({ date: "2026-03-10" }))).toEqual([]); // Tuesday
  });

  test("supports several ranges per day (lunch break) and HH:MM:SS values", () => {
    const slots = computeAvailability(
      input({
        blockMinutes: 60,
        staff: [
          staff({
            workingHours: [
              { weekday: 1, start: "09:00:00", end: "10:00:00" },
              { weekday: 1, start: "11:00:00", end: "12:00:00" },
            ],
          }),
        ],
      }),
    );
    expect(starts(slots)).toEqual(["2026-03-09T12:00:00.000Z", "2026-03-09T14:00:00.000Z"]);
  });

  test("merges staff, sorted by start time then staff id", () => {
    const slots = computeAvailability(
      input({
        blockMinutes: 180,
        staff: [staff({ staffId: "b" }), staff({ staffId: "a" })],
      }),
    );
    expect(slots.map((s) => s.staffId)).toEqual(["a", "b"]);
  });

  test("each staff member is evaluated independently", () => {
    const slots = computeAvailability(
      input({
        blockMinutes: 180,
        staff: [
          staff({
            staffId: "a",
            appointments: [range("2026-03-09T12:00:00Z", "2026-03-09T13:00:00Z")],
          }),
          staff({ staffId: "b" }),
        ],
      }),
    );
    expect(slots.map((s) => s.staffId)).toEqual(["b"]);
  });

  describe("DST", () => {
    test("spring forward (America/New_York, 2026-03-08): the missing hour is skipped", () => {
      // 02:00 EST jumps to 03:00 EDT. Local 01:00-04:00 is only two real hours.
      const slots = computeAvailability(
        input({
          date: "2026-03-08",
          timeZone: NY,
          granularityMinutes: 60,
          blockMinutes: 60,
          staff: [staff({ workingHours: [{ weekday: 0, start: "01:00", end: "04:00" }] })],
        }),
      );
      expect(starts(slots)).toEqual(["2026-03-08T06:00:00.000Z", "2026-03-08T07:00:00.000Z"]);
    });

    test("fall back (America/New_York, 2026-11-01): the repeated hour yields an extra slot", () => {
      // 02:00 EDT falls back to 01:00 EST. Local 00:00-03:00 is four real hours.
      const slots = computeAvailability(
        input({
          date: "2026-11-01",
          timeZone: NY,
          now: new Date("2026-10-01T00:00:00Z"),
          granularityMinutes: 60,
          blockMinutes: 60,
          staff: [staff({ workingHours: [{ weekday: 0, start: "00:00", end: "03:00" }] })],
        }),
      );
      expect(starts(slots)).toEqual([
        "2026-11-01T04:00:00.000Z",
        "2026-11-01T05:00:00.000Z",
        "2026-11-01T06:00:00.000Z",
        "2026-11-01T07:00:00.000Z",
      ]);
    });

    test("working hours are wall-clock: 09:00 local maps to different UTC before and after DST", () => {
      const hours = [{ weekday: 0, start: "09:00", end: "10:00" }];
      const before = computeAvailability(
        input({ date: "2026-03-01", timeZone: NY, staff: [staff({ workingHours: hours })] }),
      );
      const after = computeAvailability(
        input({ date: "2026-03-08", timeZone: NY, staff: [staff({ workingHours: hours })] }),
      );
      expect(starts(before)).toEqual(["2026-03-01T14:00:00.000Z"]); // EST, UTC-5
      expect(starts(after)).toEqual(["2026-03-08T13:00:00.000Z"]); // EDT, UTC-4
    });
  });
});
