import { describe, expect, test } from "bun:test";
import { bookingViolations, findConflicts, type WindowInput } from "./rules";

const TZ = "America/Argentina/Buenos_Aires"; // UTC-3, no DST
const at = (iso: string) => new Date(iso);

/** Monday 2026-03-09, 09:00-18:00 local = 12:00Z-21:00Z. */
const MONDAY_HOURS = [{ weekday: 1, start: "09:00", end: "18:00" }];

function input(over: Partial<WindowInput> = {}): WindowInput {
  return {
    startsAt: at("2026-03-09T12:00:00Z"),
    endsAt: at("2026-03-09T13:00:00Z"),
    timeZone: TZ,
    now: at("2026-03-02T12:00:00Z"),
    minNoticeMinutes: 60,
    maxDaysAhead: 90,
    workingHours: MONDAY_HOURS,
    timeOff: [],
    ...over,
  };
}

describe("bookingViolations", () => {
  test("a booking inside working hours with notice has no violations", () => {
    expect(bookingViolations(input())).toEqual([]);
  });

  test("a booking that starts before opening is outside working hours", () => {
    expect(
      bookingViolations(
        input({ startsAt: at("2026-03-09T11:30:00Z"), endsAt: at("2026-03-09T12:30:00Z") }),
      ),
    ).toEqual(["outside_working_hours"]);
  });

  test("a booking that ends after closing is outside working hours; ending exactly at closing is fine", () => {
    expect(
      bookingViolations(
        input({ startsAt: at("2026-03-09T20:30:00Z"), endsAt: at("2026-03-09T21:30:00Z") }),
      ),
    ).toEqual(["outside_working_hours"]);
    expect(
      bookingViolations(
        input({ startsAt: at("2026-03-09T20:00:00Z"), endsAt: at("2026-03-09T21:00:00Z") }),
      ),
    ).toEqual([]);
  });

  test("a weekday without hours is outside working hours", () => {
    expect(
      bookingViolations(
        input({ startsAt: at("2026-03-10T12:00:00Z"), endsAt: at("2026-03-10T13:00:00Z") }),
      ),
    ).toEqual(["outside_working_hours"]);
  });

  test("back-to-back ranges behave as one continuous range", () => {
    const hours = [
      { weekday: 1, start: "09:00", end: "13:00" },
      { weekday: 1, start: "13:00", end: "18:00" },
    ];
    expect(
      bookingViolations(
        input({
          workingHours: hours,
          startsAt: at("2026-03-09T15:30:00Z"),
          endsAt: at("2026-03-09T16:30:00Z"),
        }),
      ),
    ).toEqual([]);
  });

  test("a booking cannot span a break between two ranges", () => {
    const hours = [
      { weekday: 1, start: "09:00", end: "13:00" },
      { weekday: 1, start: "14:00", end: "18:00" },
    ];
    expect(
      bookingViolations(
        input({
          workingHours: hours,
          startsAt: at("2026-03-09T15:30:00Z"),
          endsAt: at("2026-03-09T17:30:00Z"),
        }),
      ),
    ).toEqual(["outside_working_hours"]);
  });

  test("overlapping time off is a violation; touching it is not", () => {
    const off = [{ start: at("2026-03-09T13:00:00Z"), end: at("2026-03-09T15:00:00Z") }];
    expect(bookingViolations(input({ timeOff: off }))).toEqual([]);
    expect(
      bookingViolations(
        input({
          timeOff: off,
          startsAt: at("2026-03-09T12:30:00Z"),
          endsAt: at("2026-03-09T13:30:00Z"),
        }),
      ),
    ).toEqual(["time_off"]);
  });

  test("min notice: one minute short is a violation, exactly the notice is fine", () => {
    const now = at("2026-03-09T11:30:00Z");
    expect(bookingViolations(input({ now }))).toEqual(["min_notice"]);
    expect(bookingViolations(input({ now: at("2026-03-09T11:00:00Z") }))).toEqual([]);
  });

  test("max days ahead is counted in salon-local days", () => {
    // now is Mon 2026-03-02 09:00 local; 7 days ahead is Mon 2026-03-09
    expect(bookingViolations(input({ maxDaysAhead: 7 }))).toEqual([]);
    expect(bookingViolations(input({ maxDaysAhead: 6 }))).toEqual(["max_days_ahead"]);
  });

  test("reports every violation in a stable order", () => {
    const result = bookingViolations(
      input({
        now: at("2026-03-09T12:00:00Z"),
        maxDaysAhead: 0,
        startsAt: at("2026-03-10T12:00:00Z"),
        endsAt: at("2026-03-10T13:00:00Z"),
        timeOff: [{ start: at("2026-03-10T00:00:00Z"), end: at("2026-03-11T00:00:00Z") }],
      }),
    );
    expect(result).toEqual(["max_days_ahead", "outside_working_hours", "time_off"]);
  });

  test("working hours follow the salon timezone across a DST change", () => {
    // New York springs forward on Sunday 2026-03-08: 09:00 local is 13:00Z (EDT), not 14:00Z.
    const ny = {
      timeZone: "America/New_York",
      now: at("2026-03-01T00:00:00Z"),
      workingHours: [{ weekday: 0, start: "09:00", end: "17:00" }],
    };
    expect(
      bookingViolations(
        input({
          ...ny,
          startsAt: at("2026-03-08T13:00:00Z"),
          endsAt: at("2026-03-08T14:00:00Z"),
        }),
      ),
    ).toEqual([]);
    expect(
      bookingViolations(
        input({
          ...ny,
          startsAt: at("2026-03-08T12:30:00Z"),
          endsAt: at("2026-03-08T13:30:00Z"),
        }),
      ),
    ).toEqual(["outside_working_hours"]);
  });
});

describe("findConflicts", () => {
  const now = at("2026-03-02T12:00:00Z");
  const appt = (id: string, startsAt: string, endsAt: string, status = "booked") => ({
    id,
    status,
    startsAt: at(startsAt),
    endsAt: at(endsAt),
  });

  test("lists upcoming appointments that fall outside hours or inside time off, with reasons", () => {
    const conflicts = findConflicts({
      now,
      timeZone: TZ,
      workingHours: MONDAY_HOURS,
      timeOff: [{ start: at("2026-03-09T14:00:00Z"), end: at("2026-03-09T16:00:00Z") }],
      appointments: [
        appt("fine", "2026-03-09T12:00:00Z", "2026-03-09T13:00:00Z"),
        appt("off", "2026-03-09T15:00:00Z", "2026-03-09T16:00:00Z"),
        appt("early", "2026-03-09T10:00:00Z", "2026-03-09T11:00:00Z"),
        appt("tuesday", "2026-03-10T14:00:00Z", "2026-03-10T15:00:00Z"),
      ],
    });
    expect(conflicts).toEqual([
      { id: "off", reasons: ["time_off"] },
      { id: "early", reasons: ["outside_working_hours"] },
      { id: "tuesday", reasons: ["outside_working_hours"] },
    ]);
  });

  test("ignores cancelled and already finished appointments", () => {
    const conflicts = findConflicts({
      now,
      timeZone: TZ,
      workingHours: [],
      timeOff: [],
      appointments: [
        appt("cancelled", "2026-03-09T12:00:00Z", "2026-03-09T13:00:00Z", "cancelled"),
        appt("past", "2026-03-01T12:00:00Z", "2026-03-01T13:00:00Z"),
        appt("future", "2026-03-09T12:00:00Z", "2026-03-09T13:00:00Z"),
      ],
    });
    expect(conflicts.map((c) => c.id)).toEqual(["future"]);
  });
});
