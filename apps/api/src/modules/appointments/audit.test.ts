import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { appointmentSchema } from "@sob/contracts";
import { auditLog } from "@sob/db";
import { asc } from "drizzle-orm";
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
let clientA: Actor;
let clientB: Actor;

beforeAll(async () => {
  t = await setupApiTest();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  f = await seedFixtures(t.db);
  [owner, clientA, clientB] = await Promise.all([
    actor(t, "owner", "owner@example.com"),
    actor(t, "client", "a@example.com"),
    actor(t, "client", "b@example.com"),
  ]);
});

const rows = () => t.db.select().from(auditLog).orderBy(asc(auditLog.createdAt), asc(auditLog.id));

async function book(who: Actor, overrides: Record<string, unknown> = {}) {
  const res = await json(
    t.app,
    "/appointments",
    "POST",
    { staffId: f.anaId, serviceIds: [f.haircutId], startsAt: MONDAY_0900, ...overrides },
    who.cookie,
  );
  return {
    res,
    appointment: res.status === 201 ? appointmentSchema.parse(await res.json()) : null,
  };
}

describe("appointment audit trail", () => {
  test("booking records who booked what", async () => {
    const { appointment } = await book(clientA);
    const [row] = await rows();
    expect(row).toMatchObject({
      actorUserId: clientA.userId,
      action: "appointment.create",
      entity: "appointment",
      entityId: appointment?.id,
    });
    expect(row?.metadata).toMatchObject({
      staffId: f.anaId,
      clientId: clientA.clientId,
      startsAt: MONDAY_0900,
    });
  });

  test("rescheduling and cancelling record the change", async () => {
    const { appointment } = await book(clientA);
    const id = appointment?.id as string;
    await json(
      t.app,
      `/appointments/${id}`,
      "PATCH",
      { version: 1, startsAt: "2026-03-09T15:00:00.000Z" },
      clientA.cookie,
    );
    await json(
      t.app,
      `/appointments/${id}`,
      "PATCH",
      { version: 2, status: "cancelled" },
      owner.cookie,
    );

    const all = await rows();
    expect(all.map((r) => r.action)).toEqual([
      "appointment.create",
      "appointment.reschedule",
      "appointment.cancel",
    ]);
    expect(all[1]).toMatchObject({
      actorUserId: clientA.userId,
      entityId: id,
      metadata: { from: MONDAY_0900, to: "2026-03-09T15:00:00.000Z" },
    });
    expect(all[2]).toMatchObject({ actorUserId: owner.userId, entityId: id });
  });

  test("rejected attempts leave no trace: forbidden, unauthenticated, slot taken, stale version", async () => {
    const { appointment } = await book(clientA);
    const id = appointment?.id as string;
    const before = (await rows()).length;

    await json(
      t.app,
      `/appointments/${id}`,
      "PATCH",
      { version: 1, status: "cancelled" },
      clientB.cookie,
    ); // 403
    await json(t.app, "/appointments", "POST", {
      staffId: f.anaId,
      serviceIds: [f.haircutId],
      startsAt: MONDAY_0900,
    }); // 401
    const taken = await book(clientB); // 409 slot_taken
    expect(taken.res.status).toBe(409);
    await json(
      t.app,
      `/appointments/${id}`,
      "PATCH",
      { version: 99, status: "cancelled" },
      clientA.cookie,
    ); // 409

    expect((await rows()).length).toBe(before);
  });
});
