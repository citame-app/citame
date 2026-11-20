import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { appointmentSchema, calendarInboxSchema } from "@sob/contracts";
import { appointment, auditLog, clientProfile } from "@sob/db";
import { eq } from "drizzle-orm";
import {
  type Actor,
  actor,
  type Fixtures,
  json,
  MONDAY_0900,
  seedFixtures,
  setupApiTest,
} from "../../test/helpers";

let t: Awaited<ReturnType<typeof setupApiTest>>;
let f: Fixtures;
let owner: Actor;
let ana: Actor;
let bea: Actor;
let client: Actor;
beforeAll(async () => {
  t = await setupApiTest({ dbSuffix: "calendar_inbox" });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  f = await seedFixtures(t.db);
  [owner, ana, bea, client] = await Promise.all([
    actor(t, "owner", "inbox-owner@test.local"),
    actor(t, "staff", "inbox-ana@test.local", { staffProfileId: f.anaId }),
    actor(t, "staff", "inbox-bea@test.local", { staffProfileId: f.beaId }),
    actor(t, "client", "inbox-client@test.local"),
  ]);
});
const call = (who: Actor | null, path = "", method = "GET", body?: unknown) =>
  json(t.app, `/admin/notifications/inbox${path}`, method, body, who?.cookie);
async function book() {
  const res = await json(
    t.app,
    "/appointments",
    "POST",
    { staffId: f.anaId, serviceIds: [f.haircutId], startsAt: MONDAY_0900 },
    client.cookie,
  );
  expect(res.status, await res.clone().text()).toBe(201);
  return appointmentSchema.parse(await res.json());
}
const inbox = async (who = owner, query = "") => {
  const res = await call(who, query);
  expect(res.status, await res.clone().text()).toBe(200);
  return calendarInboxSchema.parse(await res.json());
};

test("inbox is authenticated, calendar scoped and contains no contact details or internal notes", async () => {
  expect((await call(null)).status).toBe(401);
  expect((await call(client)).status).toBe(403);
  const booking = await book();
  const result = await inbox();
  expect(result.total).toBe(1);
  expect(result.entries[0]).toMatchObject({
    kind: "new",
    appointmentId: booking.id,
    startsAt: MONDAY_0900,
    serviceNames: ["Haircut"],
  });
  expect((await inbox(ana)).total).toBe(1);
  expect((await inbox(bea)).total).toBe(0);
  expect(JSON.stringify(result)).not.toMatch(/phone|email|notes/);
  expect(
    (await call(bea, "/archive", "POST", { ids: [result.entries[0]?.id], archived: true })).status,
  ).toBe(403);
});

test("archive survives repeat reads, is idempotent and belongs to each user; restore preserves the event", async () => {
  await book();
  const id = (await inbox()).entries[0]?.id;
  for (let i = 0; i < 2; i++)
    expect((await call(owner, "/archive", "POST", { ids: [id], archived: true })).status).toBe(200);
  expect((await inbox()).total).toBe(0);
  expect((await inbox(owner, "?archived=true")).entries[0]?.id).toBe(id);
  expect((await inbox(ana)).total).toBe(1);
  expect((await call(owner, "/archive", "POST", { ids: [id], archived: false })).status).toBe(200);
  expect((await inbox()).entries[0]?.id).toBe(id);
  expect((await inbox(owner, "?archived=true")).total).toBe(0);
});

test("history retains each event's scheduled time while linking to the current appointment", async () => {
  const booking = await book();
  for (const change of [
    { version: 1, startsAt: "2026-03-09T15:00:00.000Z" },
    { version: 2, status: "cancelled" },
  ]) {
    const res = await json(t.app, `/appointments/${booking.id}`, "PATCH", change, owner.cookie);
    expect(res.status, await res.clone().text()).toBe(200);
  }
  const result = await inbox();
  expect(result.entries.map((e) => e.kind)).toEqual(["cancelled", "rescheduled", "new"]);
  expect(result.entries[2]).toMatchObject({
    startsAt: MONDAY_0900,
    appointmentStartsAt: "2026-03-09T15:00:00.000Z",
  });
  expect((await inbox(owner, "?kind=rescheduled")).total).toBe(1);
});

test("deleted appointments and deleted clients are removed from history visibility", async () => {
  const booking = await book();
  await t.db
    .update(appointment)
    .set({ deletedAt: new Date() })
    .where(eq(appointment.id, booking.id));
  expect((await inbox()).total).toBe(0);
  await t.db.update(appointment).set({ deletedAt: null }).where(eq(appointment.id, booking.id));
  await t.db
    .update(clientProfile)
    .set({ deletedAt: new Date() })
    .where(eq(clientProfile.id, booking.clientId));
  expect((await inbox()).total).toBe(0);
});

test("history pagination is stable and a mixed unauthorized archive request changes nothing", async () => {
  const booking = await book();
  await t.db.insert(auditLog).values(
    Array.from({ length: 26 }, () => ({
      action: "appointment.reschedule",
      entity: "appointment",
      entityId: booking.id,
    })),
  );
  const first = await inbox();
  const second = await inbox(owner, "?page=2");
  expect(first).toMatchObject({ total: 27, pageSize: 25 });
  expect(second.entries).toHaveLength(2);
  expect(new Set([...first.entries, ...second.entries].map((e) => e.id)).size).toBe(27);
  const response = await json(
    t.app,
    "/appointments",
    "POST",
    { staffId: f.beaId, serviceIds: [f.haircutId], startsAt: MONDAY_0900 },
    client.cookie,
  );
  expect(response.status).toBe(201);
  const hidden = (await inbox(bea)).entries[0];
  const own = (await inbox(ana)).entries[0];
  expect(
    (await call(ana, "/archive", "POST", { ids: [own?.id, hidden?.id], archived: true })).status,
  ).toBe(403);
  expect((await inbox(ana)).total).toBe(27);
  expect((await inbox(ana, "?archived=true")).total).toBe(0);
});
