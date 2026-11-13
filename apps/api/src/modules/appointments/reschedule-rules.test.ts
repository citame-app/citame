import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { appointmentSchema, errorResponseSchema } from "@sob/contracts";
import { appointment, appointmentService, auditLog, timeOff } from "@sob/db";
import { and, eq } from "drizzle-orm";
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

/** Fixture clock: Mon 2026-03-02 09:00 local. Notice 60 min, horizon 90 days, Mon 09-18 local. */
const patch = (who: Actor, id: string, body: Record<string, unknown>) =>
  json(t.app, `/appointments/${id}`, "PATCH", body, who.cookie);
const error = async (res: Response) => errorResponseSchema.parse(await res.json()).error;

async function book(who: Actor = owner, over: Record<string, unknown> = {}) {
  const res = await json(
    t.app,
    "/appointments",
    "POST",
    {
      staffId: f.anaId,
      serviceIds: [f.haircutId],
      startsAt: MONDAY_0900,
      clientId: who.clientId ?? f.clientId,
      ...over,
    },
    who.cookie,
  );
  expect(res.status).toBe(201);
  return appointmentSchema.parse(await res.json());
}

async function expectUnchanged(booked: { id: string; startsAt: string; staffId: string }) {
  const [row] = await t.db.select().from(appointment).where(eq(appointment.id, booked.id));
  expect(row?.startsAt.toISOString()).toBe(booked.startsAt);
  expect(row).toMatchObject({ staffId: booked.staffId, version: 1 });
  const entries = await t.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityId, booked.id), eq(auditLog.action, "appointment.reschedule")));
  expect(entries).toHaveLength(0);
}

describe("reschedule applies the booking rules", () => {
  test("a move inside working hours still works and keeps the duration", async () => {
    const booked = await book();
    const res = await patch(owner, booked.id, { version: 1, startsAt: "2026-03-09T16:00:00.000Z" });
    expect(res.status).toBe(200);
    expect(appointmentSchema.parse(await res.json())).toMatchObject({
      startsAt: "2026-03-09T16:00:00.000Z",
      endsAt: "2026-03-09T17:00:00.000Z",
    });
  });

  test("moving before opening, after closing (block included) or onto a day off is slot_unavailable", async () => {
    const booked = await book();
    for (const startsAt of [
      "2026-03-09T11:00:00.000Z", // 08:00 local
      "2026-03-09T20:30:00.000Z", // block would end 18:30 local
      "2026-03-10T12:00:00.000Z", // Tuesday
    ]) {
      const res = await patch(owner, booked.id, { version: 1, startsAt });
      expect([startsAt, res.status]).toEqual([startsAt, 409]);
      expect((await error(res)).code).toBe("slot_unavailable");
    }
    await expectUnchanged(booked);
    // ending exactly at closing is fine
    expect(
      (await patch(owner, booked.id, { version: 1, startsAt: "2026-03-09T20:00:00.000Z" })).status,
    ).toBe(200);
  });

  test("moving into time off is slot_unavailable and override does not help", async () => {
    const booked = await book();
    await t.db.insert(timeOff).values({
      staffId: f.anaId,
      startsAt: new Date("2026-03-09T15:00:00Z"),
      endsAt: new Date("2026-03-09T17:00:00Z"),
    });
    for (const body of [{}, { override: true }]) {
      const res = await patch(owner, booked.id, {
        version: 1,
        startsAt: "2026-03-09T16:00:00.000Z",
        ...body,
      });
      expect(res.status).toBe(409);
      expect((await error(res)).message).toContain("time off");
    }
    await expectUnchanged(booked);
  });

  test("moving to another staff member checks that member's hours and time off", async () => {
    const booked = await book();
    await t.db.insert(timeOff).values({
      staffId: f.beaId,
      startsAt: new Date("2026-03-09T12:00:00Z"),
      endsAt: new Date("2026-03-09T13:00:00Z"),
    });
    const blocked = await patch(owner, booked.id, { version: 1, staffId: f.beaId });
    expect(blocked.status).toBe(409);
    expect((await error(blocked)).code).toBe("slot_unavailable");
    await expectUnchanged(booked);

    const ok = await patch(owner, booked.id, {
      version: 1,
      staffId: f.beaId,
      startsAt: "2026-03-09T14:00:00.000Z",
    });
    expect(ok.status).toBe(200);
    expect(appointmentSchema.parse(await ok.json()).staffId).toBe(f.beaId);
  });

  test("beyond the booking horizon is slot_unavailable", async () => {
    const booked = await book();
    const res = await patch(owner, booked.id, { version: 1, startsAt: "2026-06-08T12:00:00.000Z" });
    expect(res.status).toBe(409);
    expect((await error(res)).message).toContain("days");
  });

  test("the exclusion constraint still reports overlaps as slot_taken", async () => {
    const first = await book();
    await book(owner, { startsAt: "2026-03-09T16:00:00.000Z" });
    const res = await patch(owner, first.id, { version: 1, startsAt: "2026-03-09T16:30:00.000Z" });
    expect(res.status).toBe(409);
    expect((await error(res)).code).toBe("slot_taken");
  });
});

describe("min notice on reschedule", () => {
  const SOON = "2026-03-02T12:30:00.000Z"; // 30 minutes after the fixture clock

  test("moving inside the notice window is refused for a client", async () => {
    const mine = await book(client);
    const res = await patch(client, mine.id, { version: 1, startsAt: SOON });
    expect(res.status).toBe(409);
    expect((await error(res)).message).toContain("notice");
    await expectUnchanged(mine);
  });

  test("staff and the owner can override it, and the override is audited", async () => {
    const booked = await book();
    const res = await patch(ana, booked.id, { version: 1, startsAt: SOON, override: true });
    expect(res.status).toBe(200);
    const [entry] = await t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, booked.id), eq(auditLog.action, "appointment.reschedule")));
    expect(entry?.metadata).toMatchObject({ override: true, noticeOverridden: true });

    const second = await book(owner, { staffId: f.beaId });
    expect(
      (await patch(owner, second.id, { version: 1, startsAt: SOON, override: true })).status,
    ).toBe(200);
  });

  test("a client cannot send the override flag", async () => {
    const mine = await book(client);
    const res = await patch(client, mine.id, { version: 1, startsAt: SOON, override: true });
    expect(res.status).toBe(403);
    await expectUnchanged(mine);
  });

  test("override never bypasses working hours", async () => {
    const booked = await book();
    const res = await patch(owner, booked.id, {
      version: 1,
      startsAt: "2026-03-09T11:00:00.000Z",
      override: true,
    });
    expect(res.status).toBe(409);
    expect((await error(res)).message).toContain("working hours");
  });
});

describe("changes that are not moves are not validated", () => {
  async function insertOutsideHours() {
    const [row] = await t.db
      .insert(appointment)
      .values({
        staffId: f.anaId,
        clientId: f.clientId,
        startsAt: new Date("2026-03-10T12:00:00Z"), // Tuesday, no hours
        endsAt: new Date("2026-03-10T13:00:00Z"),
      })
      .returning();
    if (!row) throw new Error("insert failed");
    await t.db.insert(appointmentService).values({
      appointmentId: row.id,
      serviceId: f.haircutId,
      position: 0,
      name: "Haircut",
      durationMinutes: 45,
      bufferMinutes: 15,
      priceCents: 10000,
      currency: "ARS",
    });
    return row;
  }

  test("notes, cancelling and re-sending the same start or staff all work outside hours", async () => {
    const row = await insertOutsideHours();
    expect((await patch(owner, row.id, { version: 1, notes: "call first" })).status).toBe(200);
    expect(
      (
        await patch(owner, row.id, {
          version: 2,
          startsAt: row.startsAt.toISOString(),
          staffId: f.anaId,
        })
      ).status,
    ).toBe(200);
    expect((await patch(owner, row.id, { version: 3, status: "cancelled" })).status).toBe(200);
  });
});
