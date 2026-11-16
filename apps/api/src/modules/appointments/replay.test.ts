import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { appointmentSchema, listServicesResponseSchema } from "@sob/contracts";
import { appointment, auditLog, clientProfile, service } from "@sob/db";
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
beforeAll(async () => {
  t = await setupApiTest({ dbSuffix: "booking_replay" });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  f = await seedFixtures(t.db);
  owner = await actor(t, "owner", "owner@replay.test");
});
const body = () => ({
  id: Bun.randomUUIDv7(),
  staffId: f.anaId,
  clientId: f.clientId,
  serviceIds: [f.haircutId],
  startsAt: MONDAY_0900,
});
const book = (input: unknown, who = owner) =>
  json(t.app, "/appointments", "POST", input, who.cookie);

test("concurrent retries create one visit, one walk-in and one creation audit", async () => {
  const { clientId: _, ...input } = body();
  const request = { ...input, client: { name: "No contact walk-in" } };
  const before = await t.db.select().from(clientProfile);
  const responses = await Promise.all([book(request), book(request)]);
  expect(responses.map((r) => r.status)).toEqual([201, 201]);
  const visits = await Promise.all(
    responses.map(async (r) => appointmentSchema.parse(await r.json())),
  );
  expect(visits[0]).toMatchObject({ id: request.id });
  expect(visits[1]).toMatchObject({ id: request.id, clientId: visits[0]?.clientId });
  expect(await t.db.select().from(appointment)).toHaveLength(1);
  expect(await t.db.select().from(clientProfile)).toHaveLength(before.length + 1);
  expect(
    await t.db.select().from(auditLog).where(eq(auditLog.action, "appointment.create")),
  ).toHaveLength(1);
});

test("a retry recovers the frozen price after catalog changes, but a new visit must review the new quote", async () => {
  const customer = await actor(t, "client", "customer@replay.test");
  const other = await actor(t, "client", "other@replay.test");
  const { clientId: _, ...input } = body();
  const catalog = listServicesResponseSchema.parse(
    await (await json(t.app, "/services", "GET", undefined, customer.cookie)).json(),
  );
  const quote = catalog.services.find((s) => s.id === f.haircutId)?.quoteHash;
  const request = { ...input, serviceQuotes: { [f.haircutId]: quote } };
  const created = await book(request, customer);
  expect(created.status).toBe(201);
  await t.db.update(service).set({ priceCents: 19000 }).where(eq(service.id, f.haircutId));
  const replayed = await book(request, customer);
  expect(replayed.status).toBe(201);
  expect(replayed.headers.get("x-idempotent-replay")).toBe("true");
  expect(appointmentSchema.parse(await replayed.json()).services[0]?.priceCents).toBe(10000);
  expect((await book({ ...request, id: Bun.randomUUIDv7() }, customer)).status).toBe(409);
  expect((await book(request, other)).status).toBe(409);
});

test("reusing an id for a changed selection, sequence, note or another actor never replays", async () => {
  const request = { ...body(), serviceIds: [f.haircutId, f.colorId], notes: "Original" };
  expect((await book(request)).status).toBe(201);
  for (const change of [
    { serviceIds: [f.colorId] },
    { serviceIds: [f.colorId, f.haircutId] },
    { notes: "Different" },
  ]) {
    expect((await book({ ...request, ...change })).status).toBe(409);
  }
  const manager = await actor(t, "owner", "another-owner@replay.test");
  expect((await book(request, manager)).status).toBe(409);
});

test("inline retries bind the original input even when contact matching resolved an existing different name", async () => {
  await t.db
    .update(clientProfile)
    .set({ name: "Saved name", phone: "+34600000000" })
    .where(eq(clientProfile.id, f.clientId));
  const { clientId: _, ...input } = body();
  const request = { ...input, client: { name: "Name supplied at booking", phone: "+34600000000" } };
  expect((await book(request)).status).toBe(201);
  const replay = await book(request);
  expect(replay.status).toBe(201);
  expect(await replay.json()).toMatchObject({ clientId: f.clientId });
  expect(
    (await book({ ...request, client: { ...request.client, name: "Different request" } })).status,
  ).toBe(409);
});

test("a professional cannot recover a visit that the owner moved to another calendar", async () => {
  const professional = await actor(t, "staff", "professional@replay.test", {
    staffProfileId: f.anaId,
  });
  const request = body();
  expect((await book(request, professional)).status).toBe(201);
  expect(
    (
      await json(
        t.app,
        `/appointments/${request.id}`,
        "PATCH",
        { version: 1, staffId: f.beaId },
        owner.cookie,
      )
    ).status,
  ).toBe(200);
  const response = await book(request, professional);
  expect(response.status).toBe(409);
  expect(await response.text()).not.toContain(f.beaId);
});

test("legacy creation audits replay only an exact resolved-client request from the original actor", async () => {
  const request = body();
  expect((await book(request)).status).toBe(201);
  await t.db
    .update(auditLog)
    .set({ metadata: {} })
    .where(and(eq(auditLog.entityId, request.id), eq(auditLog.action, "appointment.create")));
  expect((await book(request)).status).toBe(201);
  expect((await book({ ...request, notes: "different" })).status).toBe(409);
});
