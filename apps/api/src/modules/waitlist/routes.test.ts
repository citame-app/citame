import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import {
  type Actor,
  actor,
  type Fixtures,
  json,
  seedFixtures,
  setupApiTest,
} from "../../../test/helpers";

let t: Awaited<ReturnType<typeof setupApiTest>>;
let f: Fixtures;
let owner: Actor;
let client: Actor;
let other: Actor;
const call = (who: Actor | null, path: string, method = "GET", body?: unknown) =>
  json(t.app, path, method, body, who?.cookie);
const selection = () => ({
  serviceIds: [f.haircutId],
  staffId: f.anaId,
  fromDate: "2026-03-09",
  toDate: "2026-03-16",
  fromTime: "09:00",
  toTime: "12:00",
  idempotencyKey: crypto.randomUUID(),
});
beforeAll(async () => {
  t = await setupApiTest({ dbSuffix: "waitlist" });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  f = await seedFixtures(t.db);
  [owner, client, other] = await Promise.all([
    actor(t, "owner", "waitlist-owner@test.local"),
    actor(t, "client", "waitlist-client@test.local"),
    actor(t, "client", "waitlist-other@test.local"),
  ]);
});
async function enable() {
  const r = await call(owner, "/admin/waitlist/policy", "PUT", {
    enabled: true,
    offerMinutes: 30,
    version: 1,
  });
  expect(r.status, await r.clone().text()).toBe(200);
}
test("waitlists default off and only the owner can activate the policy", async () => {
  const r = await call(client, "/me/waitlist");
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ entries: [], policy: { enabled: false } });
  expect((await call(client, "/me/waitlist", "POST", selection())).status).toBe(409);
  expect(
    (
      await call(client, "/admin/waitlist/policy", "PUT", {
        enabled: true,
        offerMinutes: 30,
        version: 1,
      })
    ).status,
  ).toBe(403);
  await enable();
  expect(
    (
      await call(owner, "/admin/waitlist/policy", "PUT", {
        enabled: true,
        offerMinutes: 30,
        version: 1,
      })
    ).status,
  ).toBe(409);
});
test("joining is customer-scoped, idempotent and bounded to a valid date and daily time window", async () => {
  await enable();
  const request = selection();
  const r = await call(client, "/me/waitlist", "POST", request);
  expect(r.status, await r.clone().text()).toBe(201);
  const entry = (await r.json()) as { id: string; clientId: string; state: string };
  expect(entry).toMatchObject({ clientId: client.clientId, state: "waiting" });
  expect((await call(client, "/me/waitlist", "POST", request)).status).toBe(201);
  expect((await call(client, "/me/waitlist", "POST", { ...request, toTime: "13:00" })).status).toBe(
    409,
  );
  expect(
    (await call(client, "/me/waitlist", "POST", { ...selection(), clientId: other.clientId }))
      .status,
  ).toBe(400);
  const others = await call(other, "/me/waitlist");
  expect(await others.json()).toMatchObject({ entries: [] });
  expect(
    (
      await call(client, "/me/waitlist", "POST", {
        ...selection(),
        fromTime: "13:00",
        toTime: "12:00",
      })
    ).status,
  ).toBe(400);
  expect(
    (await call(client, "/me/waitlist", "POST", { ...selection(), toDate: "2026-06-09" })).status,
  ).toBe(400);
});

test("duplicate selections and the five-active-request limit cannot be bypassed with fresh request keys", async () => {
  await enable();
  const request = selection();
  expect((await call(client, "/me/waitlist", "POST", request)).status).toBe(201);
  expect(
    (
      await call(client, "/me/waitlist", "POST", {
        ...request,
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(409);
  for (const fromTime of ["09:30", "10:00", "10:30", "11:00"]) {
    const r = await call(client, "/me/waitlist", "POST", { ...selection(), fromTime });
    expect(r.status).toBe(201);
  }
  expect(
    (await call(client, "/me/waitlist", "POST", { ...selection(), toTime: "13:00" })).status,
  ).toBe(409);
  expect((await call(client, "/admin/waitlist")).status).toBe(403);
});
