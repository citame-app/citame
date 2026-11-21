import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { appointmentSchema, calendarResponseSchema, errorResponseSchema } from "@sob/contracts";
import { appointment, staffProfile, timeOff } from "@sob/db";
import { eq } from "drizzle-orm";
import {
  type Actor,
  actor,
  type Fixtures,
  json,
  MONDAY_0900,
  seedFixtures,
  setupApiTest,
} from "../../../test/helpers";

let t: Awaited<ReturnType<typeof setupApiTest>>;
let f: Fixtures;
let owner: Actor;
let ana: Actor;
let client: Actor;

beforeAll(async () => {
  t = await setupApiTest();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  f = await seedFixtures(t.db);
  [owner, ana, client] = await Promise.all([
    actor(t, "owner", "owner@example.com"),
    actor(t, "staff", "ana@example.com", { staffProfileId: f.anaId }),
    actor(t, "client", "c@example.com"),
  ]);
});

/** Mon 2026-03-09 00:00 local through Mon 2026-03-16 00:00 local (UTC-3). */
const WEEK = "from=2026-03-09T03:00:00Z&to=2026-03-16T03:00:00Z";
const call = (who: Actor | null, query = WEEK) =>
  json(t.app, `/appointments/calendar?${query}`, "GET", undefined, who?.cookie);
const calendar = async (who: Actor, query = WEEK) => {
  const res = await call(who, query);
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  return calendarResponseSchema.parse(await res.json());
};

async function book(staffId: string, startsAt: string, services = [f.haircutId]) {
  const res = await json(
    t.app,
    "/appointments",
    "POST",
    { staffId, serviceIds: services, startsAt, clientId: f.clientId },
    owner.cookie,
  );
  expect(res.status).toBe(201);
  return appointmentSchema.parse(await res.json());
}

describe("access control", () => {
  test("anonymous 401, clients 403", async () => {
    expect((await call(null)).status).toBe(401);
    const res = await call(client);
    expect(res.status).toBe(403);
    expect(errorResponseSchema.parse(await res.json()).error.code).toBe("forbidden");
  });

  test("staff get only their own calendar and cannot request a colleague's", async () => {
    await book(f.anaId, MONDAY_0900);
    await book(f.beaId, MONDAY_0900);
    const own = await calendar(ana);
    expect(own.staff.map((s) => s.id)).toEqual([f.anaId]);
    expect(own.appointments.every((a) => a.staffId === f.anaId)).toBe(true);
    expect(own.appointments).toHaveLength(1);
    expect(own.workingWindows.every((w) => w.staffId === f.anaId)).toBe(true);

    expect((await call(ana, `${WEEK}&staffIds=${f.beaId}`)).status).toBe(403);
    expect((await call(ana, `${WEEK}&staffIds=${f.anaId},${f.beaId}`)).status).toBe(403);
    expect((await call(ana, `${WEEK}&staffIds=${f.anaId}`)).status).toBe(200);
  });
});

describe("GET /appointments/calendar as the owner", () => {
  test("returns appointments with client and service names, time off and working windows", async () => {
    const booked = await book(f.anaId, MONDAY_0900, [f.haircutId, f.colorId]);
    await t.db.insert(timeOff).values({
      staffId: f.beaId,
      startsAt: new Date("2026-03-10T12:00:00Z"),
      endsAt: new Date("2026-03-10T16:00:00Z"),
      reason: "Course",
    });

    const body = await calendar(owner);
    expect(body.timezone).toBe("America/Argentina/Buenos_Aires");
    expect(body.staff.map((s) => s.displayName)).toEqual(["Ana", "Bea"]);
    expect(body.appointments).toHaveLength(1);
    expect(body.appointments[0]).toMatchObject({
      id: booked.id,
      clientName: "Lucia",
      serviceNames: ["Haircut", "Color"],
      status: "booked",
    });
    expect(body.timeOff).toEqual([
      expect.objectContaining({
        staffId: f.beaId,
        reason: "Course",
        startsAt: "2026-03-10T12:00:00.000Z",
        endsAt: "2026-03-10T16:00:00.000Z",
      }),
    ]);
    // Monday 09:00-18:00 local for both staff; the following Monday starts after the range.
    expect(body.workingWindows).toEqual([
      {
        staffId: f.anaId,
        startsAt: "2026-03-09T12:00:00.000Z",
        endsAt: "2026-03-09T21:00:00.000Z",
      },
      {
        staffId: f.beaId,
        startsAt: "2026-03-09T12:00:00.000Z",
        endsAt: "2026-03-09T21:00:00.000Z",
      },
    ]);
  });

  test("staffIds limits every section", async () => {
    await book(f.anaId, MONDAY_0900);
    await book(f.beaId, MONDAY_0900);
    const body = await calendar(owner, `${WEEK}&staffIds=${f.beaId}`);
    expect(body.staff.map((s) => s.id)).toEqual([f.beaId]);
    expect(body.appointments.map((a) => a.staffId)).toEqual([f.beaId]);
    expect(body.workingWindows.map((w) => w.staffId)).toEqual([f.beaId]);
  });

  test("only appointments overlapping the range are returned, edges included", async () => {
    await book(f.anaId, "2026-03-09T12:00:00.000Z"); // inside
    // starts before the range and ends inside it: 02:30Z-03:30Z overlaps [03:00Z, ...)
    await t.db.insert(appointment).values({
      staffId: f.beaId,
      clientId: f.clientId,
      startsAt: new Date("2026-03-09T02:30:00Z"),
      endsAt: new Date("2026-03-09T03:30:00Z"),
    });
    // ends exactly when the range starts: not overlapping
    await t.db.insert(appointment).values({
      staffId: f.anaId,
      clientId: f.clientId,
      startsAt: new Date("2026-03-09T02:00:00Z"),
      endsAt: new Date("2026-03-09T03:00:00Z"),
    });
    // starts exactly when the range ends: not overlapping
    await t.db.insert(appointment).values({
      staffId: f.beaId,
      clientId: f.clientId,
      startsAt: new Date("2026-03-16T03:00:00Z"),
      endsAt: new Date("2026-03-16T04:00:00Z"),
    });
    const body = await calendar(owner);
    expect(body.appointments.map((a) => a.startsAt)).toEqual([
      "2026-03-09T02:30:00.000Z",
      "2026-03-09T12:00:00.000Z",
    ]);
  });

  test("cancelled appointments are included with their status; deleted ones are not", async () => {
    const booked = await book(f.anaId, MONDAY_0900);
    const cancel = await json(
      t.app,
      `/appointments/${booked.id}`,
      "PATCH",
      { version: booked.version, status: "cancelled" },
      owner.cookie,
    );
    expect(cancel.status).toBe(200);
    await t.db.insert(appointment).values({
      staffId: f.beaId,
      clientId: f.clientId,
      startsAt: new Date("2026-03-10T12:00:00Z"),
      endsAt: new Date("2026-03-10T13:00:00Z"),
      deletedAt: new Date(),
    });
    const body = await calendar(owner);
    expect(body.appointments.map((a) => a.status)).toEqual(["cancelled"]);
  });

  test("inactive staff are left out by default but can be requested explicitly", async () => {
    await t.db.update(staffProfile).set({ active: false }).where(eq(staffProfile.id, f.beaId));
    expect((await calendar(owner)).staff.map((s) => s.id)).toEqual([f.anaId]);
    expect((await calendar(owner, `${WEEK}&staffIds=${f.beaId}`)).staff.map((s) => s.id)).toEqual([
      f.beaId,
    ]);
  });

  test("appointments are ordered by start, then id", async () => {
    await book(f.beaId, "2026-03-09T15:00:00.000Z");
    await book(f.anaId, "2026-03-09T12:00:00.000Z");
    const body = await calendar(owner);
    expect(body.appointments.map((a) => a.startsAt)).toEqual([
      "2026-03-09T12:00:00.000Z",
      "2026-03-09T15:00:00.000Z",
    ]);
  });

  test("validates the query: 400 for bad ranges and ids, 404 for an unknown staff member", async () => {
    for (const q of [
      "from=2026-03-09T03:00:00Z",
      "from=2026-03-16T03:00:00Z&to=2026-03-09T03:00:00Z",
      "from=2026-01-01T00:00:00Z&to=2026-06-01T00:00:00Z",
      `${WEEK}&staffIds=nope`,
    ]) {
      const res = await call(owner, q);
      expect([q, res.status]).toEqual([q, 400]);
    }
    expect((await call(owner, `${WEEK}&staffIds=${Bun.randomUUIDv7()}`)).status).toBe(404);
  });
});
