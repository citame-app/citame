import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import {
  appointmentSchema,
  availabilityResponseSchema,
  checkoutSchema,
  peakPriceQuoteSchema,
  serviceCombinationSchema,
} from "@sob/contracts";
import { service, serviceStaff, staffProfile } from "@sob/db";
import { and, eq, inArray } from "drizzle-orm";
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
  await t.db
    .update(service)
    .set({ currency: "EUR" })
    .where(inArray(service.id, input().serviceIds));
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
  expect(
    (
      await call(path, "PUT", {
        ...fields,
        active: true,
        version: row.version,
        fixedTerms: draft.fixedTerms,
      })
    ).status,
  ).toBe(409);
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
  expect(
    (
      await call("/admin/services/combinations", "POST", {
        ...draft,
        fixedTerms: { pricesCents: [1200, 3400], staffIds: [f.anaId] },
      })
    ).status,
  ).toBe(400);
  await t.db.update(service).set({ currency: "EUR" }).where(inArray(service.id, draft.serviceIds));
  for (const fixedTerms of [
    { pricesCents: [1200], staffIds: [f.anaId] },
    { pricesCents: [1200, 3400], staffIds: [] },
    { pricesCents: [1200, 3400], staffIds: [crypto.randomUUID()] },
  ]) {
    const response = await call("/admin/services/combinations", "POST", { ...draft, fixedTerms });
    expect([400, 404]).toContain(response.status);
  }
});

test("a priced combination quotes and charges its frozen amounts with booking-specific staff", async () => {
  const serviceIds = [f.haircutId, f.colorId];
  await t.db.update(service).set({ currency: "EUR" }).where(inArray(service.id, serviceIds));
  await t.db
    .delete(serviceStaff)
    .where(and(eq(serviceStaff.staffId, f.anaId), eq(serviceStaff.serviceId, f.colorId)));
  const published = await call("/admin/services/combinations", "POST", {
    ...input(),
    fixedTerms: { pricesCents: [1200, 3400], staffIds: [f.anaId], onlineBooking: true },
  });
  expect(published.status).toBe(201);
  const combo = serviceCombinationSchema.parse(await published.json());
  expect(combo.bookable).toBe(true);
  expect(await (await call("/services/combinations")).json()).toEqual({ combinations: [] });
  expect(await (await call("/services/combinations?fixedTerms=1")).json()).toMatchObject({
    combinations: [{ id: combo.id, bookable: true }],
  });
  const selection = new URLSearchParams({
    serviceIds: serviceIds.join(","),
    combinationId: combo.id,
  });
  const get = (path: string, params: Record<string, string>) =>
    t.app.request(`${path}?${new URLSearchParams([...selection, ...Object.entries(params)])}`);
  const availability = await get("/availability", { date: "2026-03-09" });
  expect(availability.status).toBe(200);
  const slots = availabilityResponseSchema.parse(await availability.json()).slots;
  expect(slots.some((slot) => slot.staffId === f.anaId && slot.startsAt === MONDAY_0900)).toBe(
    true,
  );
  expect(slots.every((slot) => slot.staffId === f.anaId)).toBe(true);

  const quoteReply = await get("/availability/peak-price", { startsAt: MONDAY_0900 });
  expect(quoteReply.status).toBe(200);
  const quote = peakPriceQuoteSchema.parse(await quoteReply.json());
  expect(quote.services.map((row) => row.priceCents)).toEqual([1200, 3400]);
  const combination = quote.combination;
  if (!combination) throw new Error("Missing combination review");

  const body = {
    id: crypto.randomUUID(),
    staffId: f.anaId,
    clientId: f.clientId,
    serviceIds,
    startsAt: MONDAY_0900,
  };
  expect(
    (
      await call("/appointments/series/preview", "POST", {
        ...body,
        id: undefined,
        combination,
        cadence: "weekly",
        interval: 1,
        count: 2,
      })
    ).status,
  ).toBe(400);
  expect((await call("/appointments", "POST", body)).status).toBe(400);
  expect(
    (await call("/appointments", "POST", { ...body, staffId: f.beaId, combination })).status,
  ).toBe(400);
  const bookingReply = await call("/appointments", "POST", { ...body, combination });
  expect(bookingReply.status, await bookingReply.clone().text()).toBe(201);
  const appointment = appointmentSchema.parse(await bookingReply.json());
  expect(appointment.combinationId).toBe(combo.id);
  expect(appointment.services.map((line) => line.priceCents)).toEqual([1200, 3400]);

  const { idempotencyKey: _key, ...fields } = input();
  expect(
    (
      await call(`/admin/services/combinations/${combo.id}`, "PUT", {
        ...fields,
        version: combo.version,
        fixedTerms: { pricesCents: [1500, 3600], staffIds: [f.anaId], onlineBooking: true },
      })
    ).status,
  ).toBe(200);
  const replay = await call("/appointments", "POST", { ...body, combination });
  expect(replay.headers.get("x-idempotent-replay")).toBe("true");
  expect(
    (await call("/appointments", "POST", { ...body, id: crypto.randomUUID(), combination })).status,
  ).toBe(409);
  expect(
    (
      await call(`/appointments/${body.id}`, "PATCH", {
        version: appointment.version,
        staffId: f.beaId,
      })
    ).status,
  ).toBe(400);
  const moveQuery = new URLSearchParams({ date: "2026-03-09", serviceIds: serviceIds.join(",") });
  const reschedule = await call(`/appointments/${body.id}/availability?${moveQuery}`);
  expect(reschedule.status).toBe(200);
  const rescheduleSlots = availabilityResponseSchema.parse(await reschedule.json()).slots;
  expect(rescheduleSlots.length).toBeGreaterThan(0);
  expect(rescheduleSlots.every((slot) => slot.staffId === f.anaId)).toBe(true);
  const moved = await call(`/appointments/${body.id}`, "PATCH", {
    version: appointment.version,
    startsAt: "2026-03-09T15:00:00.000Z",
  });
  expect(moved.status, await moved.clone().text()).toBe(200);
  expect(appointmentSchema.parse(await moved.json()).services.map((row) => row.priceCents)).toEqual(
    [1200, 3400],
  );

  const receipt = await call("/admin/commerce/checkouts", "POST", {
    appointmentId: body.id,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(receipt.status, await receipt.clone().text()).toBe(201);
  expect(checkoutSchema.parse(await receipt.json())).toMatchObject({
    totalCents: 4600,
    lines: [{ unitAmountCents: 1200 }, { unitAmountCents: 3400 }],
  });

  await t.db.update(service).set({ onlineBooking: false }).where(eq(service.id, f.colorId));
  expect((await get("/availability", { date: "2026-03-09" })).status).toBe(404);
  expect((await get("/availability/peak-price", { startsAt: MONDAY_0900 })).status).toBe(404);
  expect(await (await call("/services/combinations?fixedTerms=1")).json()).toEqual({
    combinations: [],
  });
});

test("staff-only fixed terms stay private while the owner can quote and book them", async () => {
  const serviceIds = [f.haircutId, f.colorId];
  await t.db.update(service).set({ currency: "EUR" }).where(inArray(service.id, serviceIds));
  await t.db.update(service).set({ onlineBooking: false }).where(eq(service.id, f.colorId));
  const saved = await call("/admin/services/combinations", "POST", {
    ...input(),
    fixedTerms: { pricesCents: [1200, 3400], staffIds: [f.anaId], onlineBooking: false },
  });
  expect(saved.status).toBe(201);
  const combo = serviceCombinationSchema.parse(await saved.json());
  const { idempotencyKey: _key, ...legacy } = input();
  const convert = await call(`/admin/services/combinations/${combo.id}`, "PUT", {
    ...legacy,
    version: combo.version,
    fixedTerms: null,
  });
  expect(convert.status).toBe(409);
  const query = new URLSearchParams({
    combinationId: combo.id,
    startsAt: MONDAY_0900,
    date: "2026-03-09",
    serviceIds: serviceIds.join(","),
  });
  expect(await (await call("/services/combinations?fixedTerms=1")).json()).toEqual({
    combinations: [],
  });
  expect((await call(`/availability?${query}`)).status).toBe(404);
  expect((await call(`/availability/peak-price?${query}`)).status).toBe(404);
  const internalSlots = await call(`/appointments/combination-availability?${query}`);
  expect(internalSlots.status).toBe(200);
  expect(
    availabilityResponseSchema
      .parse(await internalSlots.json())
      .slots.some((slot) => slot.staffId === f.anaId),
  ).toBe(true);
  const staff = await actor(t, "staff", "staff-for-private-combo@example.com", {
    staffProfileId: f.anaId,
  });
  expect((await call("/admin/services/combinations", "GET", undefined, staff)).status).toBe(403);
  const directory = await call("/appointments/combinations", "GET", undefined, staff);
  expect(directory.status).toBe(200);
  expect(await directory.json()).toMatchObject({
    combinations: [{ id: combo.id, bookable: true }],
  });
  const quote = await call(`/appointments/peak-price?${query}`);
  expect(quote.status).toBe(200);
  const combination = peakPriceQuoteSchema.parse(await quote.json()).combination;
  if (!combination) throw new Error("Missing internal review");
  const client = await actor(t, "client", "client-for-private-combo@example.com");
  expect(
    (await call(`/appointments/combination-availability?${query}`, "GET", undefined, client))
      .status,
  ).toBe(403);
  expect((await call("/appointments/combinations", "GET", undefined, client)).status).toBe(403);
  const booking = { combination, serviceIds, staffId: f.anaId, startsAt: MONDAY_0900 };
  expect([403, 404]).toContain((await call("/appointments", "POST", booking, client)).status);
  expect((await call("/appointments", "POST", { ...booking, clientId: f.clientId })).status).toBe(
    201,
  );
});
