import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { serviceCombinationSchema } from "@sob/contracts";
import { service, serviceStaff, staffProfile } from "@sob/db";
import { eq } from "drizzle-orm";
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
beforeAll(async () => {
  t = await setupApiTest({ dbSuffix: "service_combinations" });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  f = await seedFixtures(t.db);
  owner = await actor(t, "owner", "owner@combinations.test");
});
const call = (path: string, method = "GET", body?: unknown, who = owner) =>
  json(t.app, path, method, body, who.cookie);
const input = () => ({
  name: "Cut and colour",
  description: "A sequence chosen by the salon",
  serviceIds: [f.haircutId, f.colorId],
  active: true,
  idempotencyKey: crypto.randomUUID(),
});
test("a combination can hand off to another qualified professional", async () => {
  await t.db.delete(serviceStaff).where(eq(serviceStaff.staffId, f.anaId));
  await t.db.insert(serviceStaff).values({ serviceId: f.colorId, staffId: f.anaId });
  const result = await call("/admin/services/combinations", "POST", input());
  expect(result.status).toBe(201);
  expect(await (await call("/services/combinations")).json()).toMatchObject({
    combinations: [{ bookable: true }],
  });
});
test("curated combinations keep ordered service IDs and current prices without changing appointment terms", async () => {
  const created = await call("/admin/services/combinations", "POST", input());
  expect(created.status, await created.clone().text()).toBe(201);
  const row = (await created.json()) as { id: string; version: number; serviceIds: string[] };
  expect(row.serviceIds).toEqual(input().serviceIds);
  const publicList = await call("/services/combinations");
  expect(publicList.status).toBe(200);
  expect(await publicList.json()).toMatchObject({
    combinations: [{ id: row.id, serviceIds: input().serviceIds }],
  });
  expect(
    (
      await call(`/admin/services/combinations/${row.id}`, "PUT", {
        ...(({ idempotencyKey: _key, ...fields }) => fields)(input()),
        version: row.version,
        active: false,
      })
    ).status,
  ).toBe(200);
  expect(await (await call("/services/combinations")).json()).toEqual({ combinations: [] });
  expect(
    (
      await call(`/admin/services/combinations/${row.id}`, "PUT", {
        ...(({ idempotencyKey: _key, ...fields }) => fields)(input()),
        version: row.version,
      })
    ).status,
  ).toBe(409);
});
test("rejects duplicates, unavailable selections, mixed currencies and a combination with no common professional", async () => {
  expect(
    (
      await call("/admin/services/combinations", "POST", {
        ...input(),
        serviceIds: [f.haircutId, f.haircutId],
      })
    ).status,
  ).toBe(400);
  await t.db.update(service).set({ currency: "EUR" }).where(eq(service.id, f.colorId));
  expect((await call("/admin/services/combinations", "POST", input())).status).toBe(400);
  await t.db.update(service).set({ currency: "ARS" }).where(eq(service.id, f.colorId));
  await t.db.delete(serviceStaff).where(eq(serviceStaff.serviceId, f.colorId));
  expect((await call("/admin/services/combinations", "POST", input())).status).toBe(400);
  await t.db.update(service).set({ active: false }).where(eq(service.id, f.haircutId));
  expect((await call("/admin/services/combinations", "POST", input())).status).toBe(404);
});
test("public combinations stop qualifying as soon as a service or professional is disabled", async () => {
  const created = await call("/admin/services/combinations", "POST", input());
  expect(created.status).toBe(201);
  await t.db.update(staffProfile).set({ active: false }).where(eq(staffProfile.id, f.anaId));
  expect(await (await call("/services/combinations")).json()).toEqual({ combinations: [] });
  const admin = await call("/admin/services/combinations");
  expect(await admin.json()).toMatchObject({ combinations: [{ bookable: false }] });
});
test("allows only catalog managers while keeping the public directory anonymous", async () => {
  const staff = await actor(t, "staff", "staff@combinations.test", { staffProfileId: f.anaId });
  expect((await call("/admin/services/combinations", "POST", input(), staff)).status).toBe(403);
  const customer = await actor(t, "client", "client@combinations.test");
  expect((await call("/admin/services/combinations", "GET", undefined, customer)).status).toBe(403);
  expect((await t.app.request("/services/combinations")).status).toBe(200);
});

test("concurrent creation retries keep one receipt and never overwrite a subsequently archived combination", async () => {
  const request = input();
  const responses = await Promise.all([
    call("/admin/services/combinations", "POST", request),
    call("/admin/services/combinations", "POST", request),
  ]);
  for (const response of responses) expect(response.status).toBe(201);
  const first = (await responses[0]?.json()) as { id: string; version: number };
  const second = (await responses[1]?.json()) as { id: string };
  expect(second.id).toBe(first.id);
  const { idempotencyKey: _key, ...fields } = request;
  expect(
    (
      await call(`/admin/services/combinations/${first.id}`, "PUT", {
        ...fields,
        active: false,
        version: first.version,
      })
    ).status,
  ).toBe(200);
  expect(await (await call("/admin/services/combinations", "POST", request)).json()).toMatchObject({
    id: first.id,
    active: false,
    version: first.version + 1,
  });
  expect(
    (await call("/admin/services/combinations", "POST", { ...request, name: "Another sequence" }))
      .status,
  ).toBe(409);
  expect(await (await call("/admin/services/combinations")).json()).toMatchObject({
    combinations: [{ id: first.id, active: false }],
  });
});
test("archived source terms can be retained for archiving but cannot be replaced by invalid services", async () => {
  const request = input();
  const response = await call("/admin/services/combinations", "POST", request);
  expect(response.status).toBe(201);
  const row = (await response.json()) as { id: string; version: number };
  const { idempotencyKey: _key, ...fields } = request;
  await t.db.update(service).set({ active: false }).where(eq(service.id, f.colorId));
  expect(
    (
      await call(`/admin/services/combinations/${row.id}`, "PUT", {
        ...fields,
        active: false,
        version: row.version,
        serviceIds: [f.haircutId, crypto.randomUUID()],
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await call(`/admin/services/combinations/${row.id}`, "PUT", {
        ...fields,
        active: false,
        version: row.version,
      })
    ).status,
  ).toBe(200);
});

test("a queued manager cannot create a combination after losing catalog access", async () => {
  const staff = await actor(t, "staff", "queued@combinations.test");
  if (!staff.staffId) throw new Error("Missing staff");
  await t.db
    .update(staffProfile)
    .set({ accessPreset: "manager" })
    .where(eq(staffProfile.id, staff.staffId));
  const { loadPrincipal } = await import("../../auth/principal");
  const { saveCombination } = await import("./combinations");
  const { lockScheduling } = await import("../../tx");
  const { sql } = await import("drizzle-orm");
  const principal = await loadPrincipal(t.db, staff.userId);
  if (!principal) throw new Error("Missing principal");
  let ready = () => {};
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  const configuration = t.db.transaction(async (tx) => {
    await lockScheduling(tx);
    ready();
    await resume;
    await tx
      .update(staffProfile)
      .set({ accessPreset: "professional" })
      .where(eq(staffProfile.id, staff.staffId ?? ""));
  });
  await held;
  const pending = saveCombination(t.db, input(), principal, new Date()).then(
    () => null,
    (error) => error,
  );
  try {
    let waiting = false;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const rows = await t.db.execute(
        sql`select 1 from pg_locks l join pg_stat_activity a on a.pid=l.pid where l.locktype='advisory' and not l.granted and a.datname=current_database() limit 1`,
      );
      if (rows.length) {
        waiting = true;
        break;
      }
      await Bun.sleep(10);
    }
    expect(waiting).toBe(true);
  } finally {
    release();
    await configuration;
  }
  expect(await pending).toMatchObject({ code: "forbidden" });
  expect(await (await call("/admin/services/combinations")).json()).toEqual({ combinations: [] });
});

test("keeps a discounted combination draft and its booking-specific staff rights across older edits", async () => {
  await t.db.delete(serviceStaff).where(eq(serviceStaff.serviceId, f.colorId));
  const draft = {
    ...input(),
    active: false,
    fixedTerms: { pricesCents: [1200, 3400], staffIds: [f.anaId] },
  };
  const saved = await call("/admin/services/combinations", "POST", draft);
  expect(saved.status).toBe(201);
  const row = serviceCombinationSchema.parse(await saved.json());
  expect(row).toMatchObject({ active: false, bookable: false, fixedTerms: draft.fixedTerms });
  expect(await (await call("/services/combinations")).json()).toEqual({ combinations: [] });
  expect(await (await call("/admin/services/combinations")).json()).toMatchObject({
    combinations: [{ id: row.id, fixedTerms: draft.fixedTerms }],
  });
  const path = `/admin/services/combinations/${row.id}`;
  const { idempotencyKey: _key, fixedTerms: _terms, ...fields } = draft;
  const updated = await call(path, "PUT", { ...fields, name: "New title", version: row.version });
  expect(updated.status).toBe(200);
  expect(await updated.json()).toMatchObject({ fixedTerms: draft.fixedTerms });
  expect(
    (
      await call(path, "PUT", {
        ...fields,
        serviceIds: [...fields.serviceIds].reverse(),
        version: row.version + 1,
      })
    ).status,
  ).toBe(409);
});

test("rejects incorrect price allocations and validates the combination's explicit staff list", async () => {
  const draft = { ...input(), active: false };
  for (const fixedTerms of [
    { pricesCents: [1200], staffIds: [f.anaId] },
    { pricesCents: [1200, 3400], staffIds: [] },
    { pricesCents: [1200, 3400], staffIds: [crypto.randomUUID()] },
  ]) {
    const response = await call("/admin/services/combinations", "POST", { ...draft, fixedTerms });
    expect([400, 404]).toContain(response.status);
  }
  const active = await call("/admin/services/combinations", "POST", {
    ...draft,
    active: true,
    fixedTerms: { pricesCents: [1200, 3400], staffIds: [f.anaId] },
  });
  expect(active.status).toBe(400);
});
