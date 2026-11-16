import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Appointment, Resource, WaitlistEntry } from "@sob/contracts";
import { resourceReservation } from "@sob/db";
import { eq } from "drizzle-orm";
import {
  type Actor,
  actor,
  type Fixtures,
  json,
  NOW,
  seedFixtures,
  setupApiTest,
} from "../../../test/helpers";
import { runWaitlist } from "../waitlist/matching";

let t: Awaited<ReturnType<typeof setupApiTest>>;
let f: Fixtures;
let owner: Actor;
let client: Actor;
let requestNow = NOW;
const call = (who: Actor, path: string, method = "GET", body?: unknown) =>
  json(t.app, path, method, body, who.cookie);
beforeAll(async () => {
  t = await setupApiTest({ dbSuffix: "resource_lifecycle", deps: { now: () => requestNow } });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  requestNow = NOW;
  await t.reset();
  f = await seedFixtures(t.db);
  [owner, client] = await Promise.all([
    actor(t, "owner", "owner@resource-lifecycle.test"),
    actor(t, "client", "client@resource-lifecycle.test"),
  ]);
});
async function pool(capacity = 1) {
  const r = await call(owner, "/admin/resources", "POST", {
    name: "Room",
    capacity,
    kind: "room",
    idempotencyKey: crypto.randomUUID(),
  });
  expect(r.status, await r.clone().text()).toBe(201);
  return (await r.json()) as Resource;
}
async function requirement(resourceId: string, quantity = 1, version = 1) {
  return call(owner, `/admin/services/${f.haircutId}/resources`, "PUT", {
    version,
    requirements: [{ resourceId, quantity }],
  });
}
async function book(staffId: string, startsAt = "2026-03-09T12:00:00.000Z") {
  const r = await call(owner, "/appointments", "POST", {
    staffId,
    clientId: f.clientId,
    serviceIds: [f.haircutId],
    startsAt,
  });
  expect(r.status, await r.clone().text()).toBe(201);
  return (await r.json()) as Appointment;
}
test("resource create retries are stable and neither changed payloads nor case variants create duplicates", async () => {
  const input = { name: "Room", capacity: 1, kind: "room", idempotencyKey: crypto.randomUUID() };
  const first = await call(owner, "/admin/resources", "POST", input);
  const created = (await first.json()) as Resource;
  const retry = await call(owner, "/admin/resources", "POST", input);
  expect(retry.status).toBe(201);
  expect(((await retry.json()) as Resource).id).toBe(created.id);
  expect((await call(owner, "/admin/resources", "POST", { ...input, capacity: 2 })).status).toBe(
    409,
  );
  expect(
    (
      await call(owner, "/admin/resources", "POST", {
        ...input,
        name: " room ",
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(409);
  expect(await (await call(owner, "/admin/resources")).json()).toMatchObject({
    resources: [{ id: created.id }],
  });
});
test("a conflicting move rolls back its time and units, and requirement changes preserve a visit already in progress", async () => {
  const room = await pool(2);
  expect((await requirement(room.id, 2)).status).toBe(200);
  const first = await book(f.anaId);
  await book(f.beaId, "2026-03-09T13:00:00.000Z");
  const move = await call(owner, `/appointments/${first.id}`, "PATCH", {
    version: first.version,
    startsAt: "2026-03-09T13:00:00.000Z",
  });
  expect(move.status).toBe(409);
  const units = await t.db
    .select()
    .from(resourceReservation)
    .where(eq(resourceReservation.appointmentId, first.id));
  expect(units).toHaveLength(2);
  expect(units.every((u) => u.startsAt.toISOString() === first.startsAt && u.active)).toBe(true);
  requestNow = new Date("2026-03-09T12:01:00.000Z");
  const remove = await call(owner, `/admin/services/${f.haircutId}/resources`, "PUT", {
    version: 2,
    requirements: [],
  });
  expect(remove.status, await remove.clone().text()).toBe(200);
  const inUse = await t.db
    .select()
    .from(resourceReservation)
    .where(eq(resourceReservation.appointmentId, first.id));
  expect(inUse.map((u) => [u.id, u.unitIndex])).toEqual(units.map((u) => [u.id, u.unitIndex]));
  const shrink = await call(owner, `/admin/resources/${room.id}`, "PUT", {
    name: room.name,
    kind: room.kind,
    capacity: 1,
    active: true,
    version: room.version,
  });
  expect(shrink.status).toBe(409);
  const cancel = await call(owner, `/appointments/${first.id}`, "PATCH", {
    version: first.version,
    status: "cancelled",
  });
  expect(cancel.status, await cancel.clone().text()).toBe(200);
  expect(
    (
      await call(owner, `/admin/resources/${room.id}`, "PUT", {
        name: room.name,
        kind: room.kind,
        capacity: 1,
        active: true,
        version: room.version,
      })
    ).status,
  ).toBe(200);
});
test("future requirement upgrades include offered waitlist slots and acceptance transfers their capacity once", async () => {
  const room = await pool();
  expect(
    (
      await call(owner, "/admin/waitlist/policy", "PUT", {
        enabled: true,
        offerMinutes: 30,
        version: 1,
      })
    ).status,
  ).toBe(200);
  const joined = await call(client, "/me/waitlist", "POST", {
    serviceIds: [f.haircutId],
    staffId: f.anaId,
    fromDate: "2026-03-09",
    toDate: "2026-03-09",
    fromTime: "09:00",
    toTime: "10:00",
    idempotencyKey: crypto.randomUUID(),
  });
  expect(joined.status).toBe(201);
  await runWaitlist(t.db, { now: NOW });
  const second = await book(f.beaId);
  expect((await requirement(room.id)).status).toBe(409);
  expect(
    await (await call(owner, `/admin/services/${f.haircutId}/resources`)).json(),
  ).toMatchObject({ version: 1, requirements: [] });
  expect(
    (
      await call(owner, `/appointments/${second.id}`, "PATCH", {
        version: second.version,
        status: "cancelled",
      })
    ).status,
  ).toBe(200);
  expect((await requirement(room.id)).status).toBe(200);
  const list = (await (await call(client, "/me/waitlist")).json()) as { entries: WaitlistEntry[] };
  const offered = list.entries[0];
  if (!offered?.offer) throw new Error("Missing held offer");
  const accepted = await call(client, `/me/waitlist/${offered.id}/accept`, "POST", {
    version: offered.version,
    offerId: offered.offer.id,
    expectedTotalCents: offered.offer.priceCents,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(accepted.status, await accepted.clone().text()).toBe(201);
  const result = (await accepted.json()) as { appointment: Appointment };
  const rows = await t.db.select().from(resourceReservation);
  expect(rows.filter((u) => u.active)).toHaveLength(1);
  expect(rows.find((u) => u.active)?.appointmentId).toBe(result.appointment.id);
  expect(rows.find((u) => u.offerId === offered.offer?.id)?.active).toBe(false);
});
