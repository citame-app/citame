import { describe, expect, test } from "bun:test";
import {
  adminStaffSchema,
  createTimeOffRequestSchema,
  listAdminStaffResponseSchema,
  listTimeOffQuerySchema,
  listTimeOffResponseSchema,
  scheduleConflictSchema,
  setWorkingHoursRequestSchema,
  timeOffResponseSchema,
  timeOffSchema,
  updateStaffRequestSchema,
  updateTimeOffRequestSchema,
  workingHoursResponseSchema,
} from "./index";

const uuid = "0198f5a0-7b1c-7000-8000-000000000001";
const uuid2 = "0198f5a0-7b1c-7000-8000-000000000002";

describe("admin staff", () => {
  test("parses a staff profile with activation state and login link", () => {
    const staff = {
      id: uuid,
      displayName: "Ana",
      active: true,
      userId: null,
      serviceIds: [uuid2],
    };
    expect(adminStaffSchema.parse(staff).active).toBe(true);
    expect(listAdminStaffResponseSchema.parse({ staff: [staff] }).staff).toHaveLength(1);
    expect(adminStaffSchema.safeParse({ ...staff, active: undefined }).success).toBe(false);
  });

  test("update needs at least one valid change", () => {
    expect(updateStaffRequestSchema.safeParse({ displayName: "Ana M." }).success).toBe(true);
    expect(updateStaffRequestSchema.safeParse({ active: false }).success).toBe(true);
    expect(updateStaffRequestSchema.safeParse({}).success).toBe(false);
    expect(updateStaffRequestSchema.safeParse({ displayName: "  " }).success).toBe(false);
  });
});

describe("working hours request", () => {
  const range = (weekday: number, startTime: string, endTime: string) => ({
    weekday,
    startTime,
    endTime,
  });

  test("accepts multiple ranges per weekday that do not overlap, and an empty schedule", () => {
    expect(
      setWorkingHoursRequestSchema.safeParse({
        hours: [range(1, "09:00", "13:00"), range(1, "14:00", "18:00"), range(2, "10:00", "16:00")],
      }).success,
    ).toBe(true);
    expect(setWorkingHoursRequestSchema.safeParse({ hours: [] }).success).toBe(true);
  });

  test("touching ranges are allowed", () => {
    expect(
      setWorkingHoursRequestSchema.safeParse({
        hours: [range(1, "09:00", "13:00"), range(1, "13:00", "18:00")],
      }).success,
    ).toBe(true);
  });

  test("rejects start >= end", () => {
    expect(
      setWorkingHoursRequestSchema.safeParse({ hours: [range(1, "18:00", "09:00")] }).success,
    ).toBe(false);
    expect(
      setWorkingHoursRequestSchema.safeParse({ hours: [range(1, "09:00", "09:00")] }).success,
    ).toBe(false);
  });

  test("rejects overlaps on the same weekday only", () => {
    expect(
      setWorkingHoursRequestSchema.safeParse({
        hours: [range(1, "09:00", "13:00"), range(1, "12:00", "18:00")],
      }).success,
    ).toBe(false);
    expect(
      setWorkingHoursRequestSchema.safeParse({
        hours: [range(1, "09:00", "13:00"), range(2, "12:00", "18:00")],
      }).success,
    ).toBe(true);
  });

  test("rejects malformed times and weekdays", () => {
    for (const bad of [
      range(7, "09:00", "10:00"),
      range(-1, "09:00", "10:00"),
      range(1, "9:00", "10:00"),
      range(1, "09:00", "24:00"),
      range(1, "09:60", "10:00"),
      range(1, "09:00:00", "10:00"),
    ]) {
      expect(setWorkingHoursRequestSchema.safeParse({ hours: [bad] }).success).toBe(false);
    }
  });

  test("response carries the saved hours and the conflicts they cause", () => {
    const parsed = workingHoursResponseSchema.parse({
      staffId: uuid,
      hours: [range(1, "09:00", "18:00")],
      conflicts: [
        {
          appointmentId: uuid2,
          clientId: uuid,
          startsAt: "2026-03-09T12:00:00.000Z",
          endsAt: "2026-03-09T13:00:00.000Z",
          reasons: ["outside_working_hours"],
        },
      ],
    });
    expect(parsed.conflicts[0]?.reasons).toEqual(["outside_working_hours"]);
    expect(
      scheduleConflictSchema.safeParse({
        appointmentId: uuid,
        clientId: uuid,
        startsAt: "2026-03-09T12:00:00.000Z",
        endsAt: "2026-03-09T13:00:00.000Z",
        reasons: ["lunch"],
      }).success,
    ).toBe(false);
  });
});

describe("time off", () => {
  const body = { startsAt: "2026-03-10T12:00:00.000Z", endsAt: "2026-03-10T16:00:00.000Z" };

  test("create requires a forward range and offsets", () => {
    expect(createTimeOffRequestSchema.safeParse(body).success).toBe(true);
    expect(createTimeOffRequestSchema.safeParse({ ...body, reason: "Dentist" }).success).toBe(true);
    expect(createTimeOffRequestSchema.safeParse({ ...body, endsAt: body.startsAt }).success).toBe(
      false,
    );
    expect(
      createTimeOffRequestSchema.safeParse({ ...body, startsAt: "2026-03-10T12:00:00" }).success,
    ).toBe(false);
  });

  test("update needs a change, and a range given in full must be forward", () => {
    expect(updateTimeOffRequestSchema.safeParse({ reason: "Trip" }).success).toBe(true);
    expect(updateTimeOffRequestSchema.safeParse({ reason: null }).success).toBe(true);
    expect(updateTimeOffRequestSchema.safeParse({}).success).toBe(false);
    expect(
      updateTimeOffRequestSchema.safeParse({
        startsAt: body.endsAt,
        endsAt: body.startsAt,
      }).success,
    ).toBe(false);
  });

  test("responses and the list query", () => {
    const entry = { id: uuid, staffId: uuid2, ...body, reason: null };
    expect(timeOffSchema.parse(entry).reason).toBeNull();
    expect(timeOffResponseSchema.parse({ timeOff: entry, conflicts: [] }).conflicts).toEqual([]);
    expect(listTimeOffResponseSchema.parse({ timeOff: [entry] }).timeOff).toHaveLength(1);
    expect(listTimeOffQuerySchema.safeParse({}).success).toBe(true);
    expect(listTimeOffQuerySchema.safeParse({ from: body.startsAt, to: body.endsAt }).success).toBe(
      true,
    );
    expect(listTimeOffQuerySchema.safeParse({ from: "yesterday" }).success).toBe(false);
  });
});
