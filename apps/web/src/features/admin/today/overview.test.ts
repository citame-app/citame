import { describe, expect, test } from "bun:test";
import type { CalendarAppointment } from "@sob/contracts";
import { buildOverview } from "./overview";

const BA = "America/Argentina/Buenos_Aires";
const appt = (
  id: string,
  hhmm: string,
  status: CalendarAppointment["status"],
  price = 1000,
): CalendarAppointment => {
  const startsAt = new Date(`2026-03-09T${hhmm}:00.000Z`).toISOString();
  return {
    id,
    staffId: "s1",
    clientId: "c1",
    startsAt,
    endsAt: new Date(Date.parse(startsAt) + 3_600_000).toISOString(),
    status,
    notes: null,
    version: 1,
    services: [
      {
        serviceId: null,
        name: "Cut",
        durationMinutes: 60,
        bufferMinutes: 0,
        priceCents: price,
        currency: "ARS",
      },
    ],
    createdAt: startsAt,
    updatedAt: startsAt,
    clientName: `Client ${id}`,
    serviceNames: ["Cut"],
  };
};

describe("buildOverview", () => {
  const now = new Date("2026-03-09T15:30:00.000Z"); // 12:30 in Buenos Aires
  const day = [
    appt("done", "12:00", "completed"), // 09:00 local
    appt("noshow", "13:00", "no_show"),
    appt("waiting", "14:00", "booked"), // started 10:00 local, nobody closed it
    appt("current", "15:00", "booked"), // 12:00 local, in progress
    appt("next", "17:00", "booked"),
    appt("later", "19:00", "booked"),
    appt("gone", "18:00", "cancelled"),
  ];
  const overview = buildOverview(day, now, BA);

  test("pending actions are booked appointments that already started, oldest first", () => {
    expect(overview.pending.map((a) => a.id)).toEqual(["waiting", "current"]);
  });

  test("next up is the first booked appointment that has not started", () => {
    expect(overview.nextUp?.id).toBe("next");
  });

  test("stats exclude cancelled appointments", () => {
    expect(overview.stats).toEqual({
      total: 6,
      remaining: 2,
      completed: 1,
      noShow: 1,
      expectedRevenueCents: 6000,
    });
  });

  test("the timeline is chronological and excludes cancelled", () => {
    expect(overview.timeline.map((a) => a.id)).toEqual([
      "done",
      "noshow",
      "waiting",
      "current",
      "next",
      "later",
    ]);
  });

  test("an empty day has no next up", () => {
    expect(buildOverview([], now, BA)).toMatchObject({
      nextUp: null,
      pending: [],
      stats: { total: 0 },
    });
  });
});
