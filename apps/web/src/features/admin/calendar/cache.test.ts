import { describe, expect, test } from "bun:test";
import type { CalendarResponse } from "@sob/contracts";
import { mergeAppointment, patchAppointment, removeAppointment } from "./cache";

const ID = "0198f5a0-7b1c-7000-8000-0000000000a1";
const STAFF = "0198f5a0-7b1c-7000-8000-000000000201";
const base = {
  id: ID,
  staffId: STAFF,
  clientId: "0198f5a0-7b1c-7000-8000-0000000000c1",
  startsAt: "2026-03-09T12:00:00.000Z",
  endsAt: "2026-03-09T13:00:00.000Z",
  status: "booked" as const,
  notes: null,
  version: 1,
  services: [],
  createdAt: "2026-03-01T00:00:00.000Z",
  updatedAt: "2026-03-01T00:00:00.000Z",
  clientName: "Lucia",
  serviceNames: ["Haircut"],
};
const calendar: CalendarResponse = {
  timezone: "America/Argentina/Buenos_Aires",
  from: "2026-03-09T03:00:00.000Z",
  to: "2026-03-10T03:00:00.000Z",
  staff: [{ id: STAFF, displayName: "Ana" }],
  appointments: [base],
  timeOff: [],
  workingWindows: [],
};

describe("calendar cache helpers", () => {
  test("patchAppointment changes one appointment immutably", () => {
    const next = patchAppointment(calendar, ID, { status: "completed" });
    expect(next.appointments[0]?.status).toBe("completed");
    expect(calendar.appointments[0]?.status).toBe("booked");
    expect(next.appointments[0]?.clientName).toBe("Lucia");
  });

  test("patchAppointment ignores an unknown id", () => {
    expect(patchAppointment(calendar, "nope", { status: "completed" })).toBe(calendar);
  });

  test("mergeAppointment applies the server's version but keeps the joined names", () => {
    const {
      clientName: _c,
      serviceNames: _s,
      ...server
    } = { ...base, status: "completed" as const, version: 2 };
    const next = mergeAppointment(calendar, server);
    expect(next.appointments[0]).toMatchObject({
      status: "completed",
      version: 2,
      clientName: "Lucia",
      serviceNames: ["Haircut"],
    });
  });

  test("a late mutation response cannot replace a newer live version", () => {
    const newer = patchAppointment(calendar, ID, { status: "cancelled", version: 4 });
    expect(mergeAppointment(newer, { ...base, version: 3 })).toBe(newer);
  });

  test("removeAppointment drops it", () => {
    expect(removeAppointment(calendar, ID).appointments).toEqual([]);
  });
});
