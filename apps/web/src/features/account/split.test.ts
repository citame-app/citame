import { describe, expect, test } from "bun:test";
import type { Appointment } from "@sob/contracts";
import { applyOptimisticCancel, splitAppointments } from "./split";

const make = (
  id: string,
  startsAt: string,
  status: Appointment["status"] = "booked",
): Appointment => ({
  id,
  staffId: "s",
  clientId: "c",
  startsAt,
  endsAt: new Date(Date.parse(startsAt) + 3_600_000).toISOString(),
  status,
  notes: null,
  version: 1,
  services: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const NOW = new Date("2026-03-10T12:00:00.000Z");

describe("splitAppointments", () => {
  test("upcoming holds booked appointments that have not ended, soonest first", () => {
    const result = splitAppointments(
      [
        make("late", "2026-03-20T12:00:00.000Z"),
        make("soon", "2026-03-11T12:00:00.000Z"),
        make("running", "2026-03-10T11:30:00.000Z"),
      ],
      NOW,
    );
    expect(result.upcoming.map((a) => a.id)).toEqual(["running", "soon", "late"]);
    expect(result.history).toEqual([]);
  });

  test("history holds past, cancelled, completed and missed ones, most recent first", () => {
    const result = splitAppointments(
      [
        make("old", "2026-01-01T12:00:00.000Z"),
        make("cancelled", "2026-03-15T12:00:00.000Z", "cancelled"),
        make("done", "2026-02-01T12:00:00.000Z", "completed"),
        make("missed", "2026-02-10T12:00:00.000Z", "no_show"),
      ],
      NOW,
    );
    expect(result.upcoming).toEqual([]);
    expect(result.history.map((a) => a.id)).toEqual(["cancelled", "missed", "done", "old"]);
  });
});

describe("applyOptimisticCancel", () => {
  test("marks only the targeted appointment as cancelled and bumps nothing else", () => {
    const list = [make("a", "2026-03-11T12:00:00.000Z"), make("b", "2026-03-12T12:00:00.000Z")];
    const next = applyOptimisticCancel(list, "a");
    expect(next.map((x) => x.status)).toEqual(["cancelled", "booked"]);
    expect(list[0]?.status).toBe("booked");
  });
});
