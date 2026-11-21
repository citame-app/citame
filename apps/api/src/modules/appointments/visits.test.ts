import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { appointment, appointmentVisit } from "@sob/db";
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
  owner = await actor(t, "owner", "owner@example.com");
  client = await actor(t, "client", "client@example.com");
});
const packet = () => ({
  id: crypto.randomUUID(),
  startsAt: MONDAY_0900,
  parts: [
    { staffId: f.beaId, serviceIds: [f.haircutId] },
    { staffId: f.anaId, serviceIds: [f.colorId] },
  ],
});

test("one customer confirms a sequential visit with different professionals atomically", async () => {
  const body = packet();
  const response = await json(t.app, "/appointments/visits", "POST", body, client.cookie);
  expect(response.status).toBe(201);
  const result = (await response.json()) as {
    id: string;
    appointments: {
      id: string;
      staffId: string;
      startsAt: string;
      endsAt: string;
      clientId: string;
    }[];
  };
  expect(result.id).toBe(body.id);
  expect(result.appointments.map((a) => a.staffId)).toEqual([f.beaId, f.anaId]);
  expect(result.appointments[1]?.startsAt).toBe(result.appointments[0]?.endsAt);
  expect(new Set(result.appointments.map((a) => a.clientId)).size).toBe(1);
  const replay = await json(t.app, "/appointments/visits", "POST", body, client.cookie);
  expect(replay.status).toBe(201);
  expect(await replay.json()).toEqual(result);
  expect(await t.db.select().from(appointment)).toHaveLength(2);
  const changed = await json(
    t.app,
    "/appointments/visits",
    "POST",
    { ...body, notes: "changed intent" },
    client.cookie,
  );
  expect(changed.status).toBe(409);
});

test("a conflict in the second treatment rolls back the entire visit", async () => {
  expect(
    (
      await json(
        t.app,
        "/appointments",
        "POST",
        { staffId: f.anaId, serviceIds: [f.colorId], startsAt: MONDAY_0900, clientId: f.clientId },
        owner.cookie,
      )
    ).status,
  ).toBe(201);
  const result = await json(t.app, "/appointments/visits", "POST", packet(), client.cookie);
  expect(result.status).toBe(409);
  expect(await t.db.select().from(appointment)).toHaveLength(1);
});

test("pausing online booking blocks new public visits and preserves staff booking and replay", async () => {
  const book = (actor: Actor, body: unknown) =>
    json(t.app, "/appointments/visits", "POST", body, actor.cookie);
  const original = { ...packet(), notes: "Customer note for both treatments" };
  const created = await book(client, original);
  expect(created.status).toBe(201);
  expect(
    (await json(t.app, "/admin/settings", "PATCH", { onlineBookingEnabled: false }, owner.cookie))
      .status,
  ).toBe(200);
  expect((await book(client, original)).status).toBe(201);
  const next = { ...packet(), startsAt: "2026-03-16T12:00:00.000Z" };
  const blocked = await book(client, next);
  expect(blocked.status, await blocked.clone().text()).toBe(409);
  expect(await blocked.json()).toMatchObject({ error: { code: "online_booking_paused" } });
  expect(await t.db.select().from(appointmentVisit)).toHaveLength(1);
  expect(await t.db.select().from(appointment)).toHaveLength(2);
  expect((await t.db.select().from(appointment)).map((row) => row.customerComment)).toEqual([
    original.notes,
    original.notes,
  ]);
  const staff = await book(owner, { ...next, clientId: f.clientId });
  expect(staff.status, await staff.clone().text()).toBe(201);
});

test("availability resolves the hand-off and concurrent duplicate confirmations create one visit", async () => {
  const input = packet();
  const availability = await json(t.app, "/services/visit-availability", "POST", {
    date: "2026-03-09",
    parts: input.parts,
  });
  expect(availability.status).toBe(200);
  const { slots } = (await availability.json()) as {
    slots: { startsAt: string; parts: { startsAt: string; staffId: string }[] }[];
  };
  expect(slots.find((s) => s.startsAt === MONDAY_0900)?.parts.map((p) => p.staffId)).toEqual([
    f.beaId,
    f.anaId,
  ]);
  const responses = await Promise.all([
    json(t.app, "/appointments/visits", "POST", input, client.cookie),
    json(t.app, "/appointments/visits", "POST", input, client.cookie),
  ]);
  expect(responses.map((r) => r.status)).toEqual([201, 201]);
  expect(await responses[0]?.json()).toEqual(await responses[1]?.json());
  expect(await t.db.select().from(appointment)).toHaveLength(2);
});

test("visits cannot substitute another customer, repeat a service or cross ownership on replay", async () => {
  const body = packet();
  expect(
    (
      await json(
        t.app,
        "/appointments/visits",
        "POST",
        { ...body, clientId: f.clientId },
        client.cookie,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await json(
        t.app,
        "/appointments/visits",
        "POST",
        { ...body, parts: [body.parts[0], body.parts[0]] },
        client.cookie,
      )
    ).status,
  ).toBe(400);
  expect((await json(t.app, "/appointments/visits", "POST", body, client.cookie)).status).toBe(201);
  const stranger = await actor(t, "client", "other@example.com");
  expect((await json(t.app, "/appointments/visits", "POST", body, stranger.cookie)).status).toBe(
    409,
  );
  expect(
    (await json(t.app, `/appointments/visits/${body.id}`, "GET", undefined, stranger.cookie))
      .status,
  ).toBe(403);
});
