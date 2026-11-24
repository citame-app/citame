import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import {
  scheduleAccessScope,
  WAITLIST_ACCESS_SCOPE_HEADER,
  waitlistEntrySchema,
} from "@sob/contracts";
import { reminder, service, waitlistEntry, waitlistOffer, waitlistSourceEntry } from "@sob/db";
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
import { runWaitlist } from "./matching";

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
test("a scoped waitlist read rejects a different browser account or staff access preset", async () => {
  const professional = await actor(t, "staff", "waitlist-staff@test.local", {
    staffProfileId: f.anaId,
  });
  const forClient = scheduleAccessScope({ ...client, role: "client" });
  const forStaff = scheduleAccessScope({ ...professional, role: "staff" });
  const read = (path: string, cookie: string, expected: string) =>
    t.app.request(path, { headers: { cookie, [WAITLIST_ACCESS_SCOPE_HEADER]: expected } });

  const own = await read("/me/waitlist", client.cookie, forClient);
  expect(own.status).toBe(200);
  expect(own.headers.get("cache-control")).toBe("private, no-store");
  expect((await read("/me/waitlist", other.cookie, forClient)).status).toBe(403);
  expect((await read("/admin/waitlist", professional.cookie, forStaff)).status).toBe(200);
  const priorScope = scheduleAccessScope({
    ...professional,
    role: "staff",
    accessPreset: "manager",
  });
  expect(
    (await read("/admin/waitlist?active=true&pageSize=1", professional.cookie, priorScope)).status,
  ).toBe(403);
  expect((await call(owner, "/admin/waitlist")).status).toBe(200);
});

test("calendar counts and pages include only active requests intersecting the displayed dates", async () => {
  await enable();
  const first = await call(client, "/me/waitlist", "POST", {
    ...selection(),
    toDate: "2026-03-10",
  });
  expect(first.status).toBe(201);
  const entry = (await first.json()) as { id: string; version: number };
  const second = await call(client, "/me/waitlist", "POST", {
    ...selection(),
    fromDate: "2026-03-16",
    toDate: "2026-03-17",
  });
  expect(second.status).toBe(201);
  const selected = await call(
    owner,
    "/admin/waitlist?active=true&fromDate=2026-03-10&toDate=2026-03-10&pageSize=1",
  );
  expect(await selected.json()).toMatchObject({ total: 1, entries: [{ id: entry.id }] });
  const wholeWeek = await call(
    owner,
    "/admin/waitlist?active=true&fromDate=2026-03-10&toDate=2026-03-16&pageSize=1",
  );
  expect(await wholeWeek.json()).toMatchObject({ total: 2, pageSize: 1 });
  expect(
    (await call(client, `/me/waitlist/${entry.id}/cancel`, "POST", { version: entry.version }))
      .status,
  ).toBe(200);
  const active = await call(
    owner,
    "/admin/waitlist?active=true&fromDate=2026-03-10&toDate=2026-03-10",
  );
  expect(await active.json()).toMatchObject({ total: 0, entries: [] });
});
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
async function addImportedRequest(clientId: string) {
  const sourceId = crypto.randomUUID();
  await t.db.insert(waitlistSourceEntry).values({
    id: sourceId,
    clientId,
    requestedDate: "2026-03-09",
    durationMinutes: 90,
    flexible: false,
    sourceOrder: 1,
    sourceHash: "synthetic",
    capturedAt: new Date("2026-03-01T10:00:00Z"),
  });
  return sourceId;
}

test("an imported request can be prepared while paused without creating offers or advancing priority", async () => {
  const sourceId = await addImportedRequest(client.clientId!);
  const readSource = () =>
    t.db.select().from(waitlistSourceEntry).where(eq(waitlistSourceEntry.id, sourceId));
  const [original] = await readSource();
  if (!original) throw new Error("The synthetic source request was not archived");
  expect(original.linkedEntryId).toBeNull();
  const staff = await actor(t, "staff", "waitlist-import-staff@test.local", {
    staffProfileId: f.anaId,
  });
  const list = await (await call(owner, "/admin/waitlist")).json();
  expect(list).toMatchObject({ entries: [], imported: [{ id: sourceId, durationMinutes: 90 }] });
  expect(await (await call(client, "/me/waitlist")).json()).not.toHaveProperty("imported");
  expect(await (await call(staff, "/admin/waitlist")).json()).not.toHaveProperty("imported");
  expect(await t.db.select().from(waitlistOffer)).toHaveLength(0);
  const request = {
    ...selection(),
    staffId: null,
    serviceIds: [f.colorId],
    toDate: "2026-03-09",
    clientId: client.clientId,
    importedEntryId: sourceId,
  };
  expect((await call(staff, "/admin/waitlist", "POST", request)).status).toBe(403);
  expect((await call(client, "/me/waitlist", "POST", selection())).status).toBe(409);
  expect(
    (await call(owner, "/admin/waitlist", "POST", { ...selection(), clientId: client.clientId }))
      .status,
  ).toBe(409);
  const mismatched = { ...request, fromDate: "2026-03-10", toDate: "2026-03-10" };
  expect((await call(owner, "/admin/waitlist", "POST", mismatched)).status).toBe(400);
  const missingPreference = { ...request, staffId: undefined };
  expect((await call(owner, "/admin/waitlist", "POST", missingPreference)).status).toBe(400);
  const requests = [request, { ...request, idempotencyKey: crypto.randomUUID() }];
  const replies = await Promise.all(
    requests.map((body) => call(owner, "/admin/waitlist", "POST", body)),
  );
  expect(replies.map(({ status }) => status).sort()).toEqual([201, 409]);
  const winner = replies.findIndex(({ status }) => status === 201);
  const saved = waitlistEntrySchema.parse(await replies[winner]!.json());
  expect(saved.staffId).toBeNull();
  const [entry] = await t.db.select().from(waitlistEntry);
  expect(entry).toMatchObject({ state: "waiting", lastScannedAt: null });
  expect(await (await call(owner, "/admin/waitlist")).json()).not.toHaveProperty("imported");
  expect(await runWaitlist(t.db, { now: NOW })).toMatchObject({
    offersCreated: 0,
    entriesScanned: 0,
  });
  expect(await t.db.select().from(waitlistEntry)).toEqual([entry!]);
  expect(await t.db.select().from(waitlistOffer)).toHaveLength(0);
  expect(await t.db.select().from(reminder)).toHaveLength(0);
  expect(await readSource()).toEqual([{ ...original, linkedEntryId: saved.id }]);
  await enable();
  const replay = await call(owner, "/admin/waitlist", "POST", requests[winner]);
  expect(replay.status).toBe(201);
  expect(await replay.json()).toMatchObject({ id: saved.id });
  expect(await runWaitlist(t.db, { now: NOW })).toMatchObject({ offersCreated: 1 });
  expect(await readSource()).toEqual([{ ...original, linkedEntryId: saved.id }]);
});

test("an enabled waitlist cannot activate an imported request", async () => {
  const sourceId = await addImportedRequest(client.clientId!);
  await enable();
  const response = await call(owner, "/admin/waitlist", "POST", {
    ...selection(),
    serviceIds: [f.colorId],
    toDate: "2026-03-09",
    clientId: client.clientId,
    importedEntryId: sourceId,
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    error: {
      code: "invalid_state",
      message: "Pause automatic offers before importing a waitlist request",
    },
  });
  expect(await t.db.select().from(waitlistSourceEntry)).toMatchObject([
    { id: sourceId, linkedEntryId: null },
  ]);
  expect(await t.db.select().from(waitlistEntry)).toHaveLength(0);
  expect(await t.db.select().from(waitlistOffer)).toHaveLength(0);
  expect(await t.db.select().from(reminder)).toHaveLength(0);
});

test("a service duration change after review cannot create an offer with a different imported duration", async () => {
  const sourceId = await addImportedRequest(client.clientId!);
  const response = await call(owner, "/admin/waitlist", "POST", {
    ...selection(),
    serviceIds: [f.colorId],
    toDate: "2026-03-09",
    clientId: client.clientId,
    importedEntryId: sourceId,
  });
  expect(response.status).toBe(201);
  await t.db.update(service).set({ durationMinutes: 120 }).where(eq(service.id, f.colorId));
  await enable();
  expect(await runWaitlist(t.db, { now: NOW })).toMatchObject({
    offersCreated: 0,
    entriesScanned: 1,
  });
  expect(await t.db.select().from(waitlistEntry)).toMatchObject([{ state: "unavailable" }]);
  expect(await t.db.select().from(waitlistSourceEntry)).toMatchObject([
    { id: sourceId, durationMinutes: 90 },
  ]);
  expect(await t.db.select().from(reminder)).toHaveLength(0);
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
