import { describe, expect, test } from "bun:test";
import {
  calendarAppointmentSchema,
  calendarQuerySchema,
  calendarResponseSchema,
  workingWindowSchema,
} from "./index";

const uuid = "0198f5a0-7b1c-7000-8000-000000000001";
const uuid2 = "0198f5a0-7b1c-7000-8000-000000000002";
const range = { from: "2026-03-09T03:00:00Z", to: "2026-03-16T03:00:00Z" };

describe("calendar query", () => {
  test("accepts six local weeks with the extra DST hour but rejects a seventh day", () => {
    expect(
      calendarQuerySchema.safeParse({ from: "2028-09-24T22:00:00Z", to: "2028-11-05T23:00:00Z" })
        .success,
    ).toBe(true);
    expect(
      calendarQuerySchema.safeParse({ from: "2028-09-24T22:00:00Z", to: "2028-11-06T23:00:00Z" })
        .success,
    ).toBe(false);
  });
  test("accepts a range with no staff filter", () => {
    const parsed = calendarQuerySchema.parse(range);
    expect(parsed.staffIds).toBeUndefined();
  });

  test("parses comma-separated staffIds into an array", () => {
    expect(calendarQuerySchema.parse({ ...range, staffIds: `${uuid},${uuid2}` }).staffIds).toEqual([
      uuid,
      uuid2,
    ]);
  });

  test("rejects missing, inverted and over-long ranges", () => {
    expect(calendarQuerySchema.safeParse({ from: range.from }).success).toBe(false);
    expect(calendarQuerySchema.safeParse({ from: range.to, to: range.from }).success).toBe(false);
    expect(
      calendarQuerySchema.safeParse({ from: "2026-03-01T00:00:00Z", to: "2026-05-01T00:00:00Z" })
        .success,
    ).toBe(false);
    // exactly 42 days is the limit
    expect(
      calendarQuerySchema.safeParse({ from: "2026-03-01T00:00:00Z", to: "2026-04-12T00:00:00Z" })
        .success,
    ).toBe(true);
  });

  test("rejects malformed or empty staffIds", () => {
    expect(calendarQuerySchema.safeParse({ ...range, staffIds: "nope" }).success).toBe(false);
    expect(calendarQuerySchema.safeParse({ ...range, staffIds: "" }).success).toBe(false);
    expect(calendarQuerySchema.safeParse({ ...range, staffIds: `${uuid},${uuid}` }).success).toBe(
      false,
    );
  });
});

describe("calendar response", () => {
  const appointment = {
    id: uuid,
    staffId: uuid2,
    clientId: uuid,
    startsAt: "2026-03-09T12:00:00.000Z",
    endsAt: "2026-03-09T13:00:00.000Z",
    status: "booked",
    notes: null,
    version: 1,
    services: [],
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    clientName: "Lucia",
    serviceNames: ["Haircut"],
  };

  test("an appointment carries the joined client and service names", () => {
    expect(calendarAppointmentSchema.parse(appointment).clientName).toBe("Lucia");
    expect(
      calendarAppointmentSchema.safeParse({ ...appointment, clientName: undefined }).success,
    ).toBe(false);
  });

  test("working windows are instants per staff member", () => {
    expect(
      workingWindowSchema.safeParse({
        staffId: uuid,
        startsAt: "2026-03-09T12:00:00.000Z",
        endsAt: "2026-03-09T21:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      workingWindowSchema.safeParse({ staffId: uuid, startsAt: "09:00", endsAt: "18:00" }).success,
    ).toBe(false);
  });

  test("a full response parses", () => {
    const parsed = calendarResponseSchema.parse({
      timezone: "America/Argentina/Buenos_Aires",
      from: range.from,
      to: range.to,
      staff: [{ id: uuid2, displayName: "Ana" }],
      appointments: [appointment],
      timeOff: [
        {
          id: uuid,
          staffId: uuid2,
          startsAt: "2026-03-10T12:00:00.000Z",
          endsAt: "2026-03-10T14:00:00.000Z",
          reason: null,
        },
      ],
      workingWindows: [
        {
          staffId: uuid2,
          startsAt: "2026-03-09T12:00:00.000Z",
          endsAt: "2026-03-09T21:00:00.000Z",
        },
      ],
    });
    expect(parsed.appointments).toHaveLength(1);
    expect(calendarResponseSchema.safeParse({ timezone: "x" }).success).toBe(false);
  });
});
