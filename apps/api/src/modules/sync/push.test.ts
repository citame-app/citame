import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  adminServiceSchema,
  desktopSalonSettingsSchema,
  listAdminServicesResponseSchema,
  serviceSchema,
} from "@sob/contracts";
import {
  appointment,
  clientProfile,
  salonSettings,
  service,
  staffProfile,
  syncMutation,
  timeOff,
} from "@sob/db";
import { eq, sql } from "drizzle-orm";
import {
  type Actor,
  actor,
  countOverlaps,
  type Fixtures,
  json,
  MONDAY_0900,
  seedFixtures,
  setupApiTest,
} from "../../../test/helpers";
import { errorCodeOf, mid, mutation, pull, pullAll, push, uuid } from "../../../test/sync";

let t: Awaited<ReturnType<typeof setupApiTest>>;
let f: Fixtures;
let owner: Actor;
let ana: Actor;
let bea: Actor;
let client: Actor;

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const MONDAY_1400 = "2026-03-09T15:00:00.000Z";

beforeAll(async () => {
  t = await setupApiTest({ dbSuffix: "sync" });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  f = await seedFixtures(t.db);
  [owner, ana, bea, client] = await Promise.all([
    actor(t, "owner", "owner@example.com"),
    actor(t, "staff", "ana@example.com", { staffProfileId: f.anaId }),
    actor(t, "staff", "bea@example.com", { staffProfileId: f.beaId }),
    actor(t, "client", "c@example.com"),
  ]);
});

const createAppt = (overrides: Partial<{ id: string; staffId: string; startsAt: string }> = {}) =>
  mutation("appointment.create", {
    id: overrides.id ?? uuid(),
    staffId: overrides.staffId ?? f.anaId,
    serviceIds: [f.haircutId],
    startsAt: overrides.startsAt ?? MONDAY_0900,
    clientId: f.clientId,
  });

const rows = async <T>(query: ReturnType<typeof sql>) =>
  (await t.db.execute(query)) as unknown as T[];

test("native service creation replays once and keeps its professional assignment", async () => {
  const id = uuid();
  const create = {
    mutationId: mid(),
    createdAt: new Date().toISOString(),
    kind: "service.create",
    payload: {
      id,
      service: {
        name: "New native treatment",
        durationMinutes: 40,
        currency: "EUR",
        priceCents: 2900,
        staffIds: [f.anaId],
      },
    },
  };
  expect((await push(t, ana, [{ ...create, mutationId: mid() }])).body.results[0]).toMatchObject({
    status: "rejected",
    reason: "forbidden",
  });
  const results = await Promise.all([push(t, owner, [create]), push(t, owner, [create])]);
  expect(results.map((response) => response.body.results[0]?.status)).toEqual([
    "applied",
    "applied",
  ]);
  expect(
    results
      .map(({ body }) => {
        const result = body.results[0];
        return result?.status === "applied" && result.replayed;
      })
      .sort(),
  ).toEqual([false, true]);
  const { services } = listAdminServicesResponseSchema.parse(
    await (await json(t.app, "/admin/services", "GET", undefined, owner.cookie)).json(),
  );
  expect(services.filter((row) => row.id === id)).toEqual([
    expect.objectContaining({ name: create.payload.service.name, staffIds: [f.anaId] }),
  ]);
});

test("a reviewed native service edit cannot overwrite a newer Cloud version", async () => {
  const path = `/admin/services/${f.haircutId}`;
  expect((await pull(t, owner)).viewerEditCatalogue).toBe(true);
  expect((await pull(t, ana)).viewerEditCatalogue).toBe(false);
  await t.db
    .update(staffProfile)
    .set({ accessPreset: "manager" })
    .where(eq(staffProfile.id, f.anaId));
  expect((await pull(t, ana)).viewerEditCatalogue).toBe(true);
  const snapshot = (await pullAll(t, owner)).changes.find(
    (change) => change.entity === "service" && change.id === f.haircutId && change.op === "upsert",
  );
  expect(snapshot?.data).toMatchObject({ version: 1 });
  const edit = {
    mutationId: mid(),
    createdAt: new Date().toISOString(),
    kind: "service.configure",
    payload: { id: f.haircutId, version: 1, service: { priceCents: 4800 } },
  };
  const browser = await json(t.app, path, "PATCH", { priceCents: 4900 }, owner.cookie);
  expect(browser.status).toBe(200);
  expect((await push(t, owner, [edit])).body.results[0]).toMatchObject({
    status: "rejected",
    reason: "conflict",
  });
  const revised = {
    ...edit,
    mutationId: mid(),
    payload: { ...edit.payload, version: 2 },
  };
  expect((await push(t, ana, [revised])).body.results[0]).toMatchObject({
    status: "applied",
  });
  expect((await push(t, ana, [revised])).body.results[0]).toMatchObject({
    status: "applied",
    replayed: true,
  });
  const [row] = await t.db.select().from(service).where(eq(service.id, f.haircutId));
  expect(row).toMatchObject({ catalogVersion: 3, priceCents: 4800 });
});

test("native service configuration commits the service and its performers together", async () => {
  const id = f.haircutId;
  const originalTeam = [f.anaId, f.beaId];
  const edit = (version: number, staffIds: string[], reviewedStaffIds = originalTeam) =>
    mutation("service.configure", {
      id,
      version,
      service: { priceCents: 8300 },
      assignment: { staffIds, reviewedStaffIds },
    });
  const details = async () => {
    const rows = listAdminServicesResponseSchema.parse(
      await (await json(t.app, "/admin/services", "GET", undefined, owner.cookie)).json(),
    ).services;
    return rows.find((row) => row.id === id);
  };
  const original = await details();
  expect(original?.staffIds.sort()).toEqual(originalTeam.sort());
  expect((await push(t, owner, [edit(1, [uuid()])])).body.results[0]).toMatchObject({
    status: "rejected",
    reason: "not_found",
  });
  expect(await details()).toEqual(original);
  expect((await push(t, owner, [edit(1, [f.beaId], [])])).body.results[0]).toMatchObject({
    status: "rejected",
    reason: "conflict",
  });
  expect(await details()).toEqual(original);
  const saved = edit(1, [f.beaId]);
  expect((await push(t, owner, [saved])).body.results[0]).toMatchObject({ status: "applied" });
  expect((await push(t, owner, [saved])).body.results[0]).toMatchObject({
    status: "applied",
    replayed: true,
  });
  expect(await details()).toMatchObject({ version: 3, priceCents: 8300, staffIds: [f.beaId] });
  const onlyStaff = mutation("service.configure", {
    id,
    version: 3,
    assignment: { reviewedStaffIds: [f.beaId], staffIds: [f.anaId] },
  });
  expect((await push(t, owner, [onlyStaff])).body.results[0]).toMatchObject({ status: "applied" });
  expect(await details()).toMatchObject({ version: 4, priceCents: 8300, staffIds: [f.anaId] });
});

test("native service configuration applies option terms with other edits in one transaction", async () => {
  const addon = await json(
    t.app,
    "/admin/services",
    "POST",
    {
      name: "Extra",
      durationMinutes: 0,
      priceCents: 300,
      staffIds: [],
      catalog: { kind: "addon", allowedServiceIds: [f.haircutId] },
    },
    owner.cookie,
  );
  expect(addon.status).toBe(201);
  const initial = adminServiceSchema.parse(await addon.json());
  const id = initial.id;
  const save = (eligible: string) => ({
    mutationId: mid(),
    createdAt: new Date().toISOString(),
    kind: "service.configure",
    payload: {
      id,
      version: 1,
      service: { priceCents: 500 },
      assignment: { staffIds: [f.anaId], reviewedStaffIds: [] },
      catalog: { kind: "addon", version: 1, allowedServiceIds: [eligible] },
    },
  });
  const active = async () =>
    listAdminServicesResponseSchema
      .parse(await (await json(t.app, "/admin/services", "GET", undefined, owner.cookie)).json())
      .services.find((row) => row.id === id);

  expect((await push(t, owner, [save(id)])).body.results[0]).toMatchObject({
    status: "rejected",
    reason: "invalid",
  });
  expect(await active()).toEqual(initial);
  const valid = save(f.colorId);
  expect((await push(t, owner, [valid])).body.results[0]).toMatchObject({ status: "applied" });
  expect((await push(t, owner, [valid])).body.results[0]).toMatchObject({
    status: "applied",
    replayed: true,
  });
  expect(await active()).toMatchObject({
    version: 4,
    priceCents: 500,
    staffIds: [f.anaId],
    catalog: { kind: "addon", version: 4, allowedServiceIds: [f.colorId] },
  });
  const changed = await active();
  const foreignCurrency = changed?.currency === "CHF" ? "EUR" : "CHF";
  const currencyOnly = mutation("service.configure", {
    id,
    version: 4,
    service: { currency: foreignCurrency },
  });
  expect((await push(t, owner, [currencyOnly])).body.results[0]).toMatchObject({
    status: "rejected",
    reason: "invalid",
  });
  expect(await active()).toEqual(changed);
});

test("native service configuration can rename a variant without changing its parent", async () => {
  const response = await json(
    t.app,
    "/admin/services",
    "POST",
    {
      name: "Cut variant",
      durationMinutes: 40,
      priceCents: 2400,
      catalog: { kind: "variant", parentServiceId: f.haircutId, optionLabel: "Short" },
    },
    owner.cookie,
  );
  expect(response.status).toBe(201);
  const initial = adminServiceSchema.parse(await response.json());
  const save = mutation("service.configure", {
    id: initial.id,
    version: 1,
    catalog: { kind: "variant", optionLabel: "Medium", version: 1 },
  });
  expect((await push(t, ana, [save])).body.results[0]).toMatchObject({
    status: "rejected",
    reason: "forbidden",
  });
  const approved = { ...save, mutationId: mid() };
  expect((await push(t, owner, [approved])).body.results[0]).toMatchObject({ status: "applied" });
  const services = listAdminServicesResponseSchema.parse(
    await (await json(t.app, "/admin/services", "GET", undefined, owner.cookie)).json(),
  ).services;
  expect(services.find((row) => row.id === initial.id)).toEqual({
    ...initial,
    version: 2,
    catalog: { kind: "variant", parentServiceId: f.haircutId, optionLabel: "Medium", version: 2 },
  });
});

test("native combinations preserve ordered services and reject stale Cloud edits", async () => {
  const id = uuid();
  const fields = {
    name: "Hair care",
    description: "Cut followed by colour",
    serviceIds: [f.haircutId, f.colorId],
    active: true,
  };
  const create = mutation("combination.create", { id, ...fields });
  const combinations = (who: Actor, mode: "full" | "delta", since: number) =>
    pull(t, who, { since, combinations: mode });
  const initial = await pull(t, owner);
  expect((await push(t, ana, [{ ...create, mutationId: mid() }])).body.results[0]).toMatchObject({
    status: "rejected",
    reason: "forbidden",
  });
  const committed = (await push(t, owner, [create])).body.results[0];
  expect(committed).toMatchObject({ status: "applied", appliedSeq: expect.any(Number) });
  expect((await push(t, owner, [create])).body.results[0]).toMatchObject({
    status: "applied",
    replayed: true,
  });
  expect((await push(t, owner, [{ ...create, mutationId: mid() }])).body.results[0]).toMatchObject({
    status: "rejected",
    reason: "invalid_state",
  });
  expect(await combinations(owner, "delta", initial.headSeq)).toMatchObject({
    combinations: [{ id, ...fields, version: 1 }],
  });
  expect(
    (await pull(t, owner, { since: initial.headSeq, combinationCatalogue: "1" })).refresh,
  ).toContain("service_combinations");
  expect((await pull(t, owner, { since: initial.headSeq })).refresh ?? []).not.toContain(
    "service_combinations",
  );
  expect(await combinations(ana, "full", 0)).not.toHaveProperty("combinations");
  await t.db.update(service).set({ onlineBooking: false }).where(eq(service.id, f.colorId));
  const hiddenCreate = mutation("combination.create", { ...fields, id: uuid() });
  expect((await push(t, owner, [hiddenCreate])).body.results[0]).toMatchObject({
    status: "rejected",
    reason: "invalid",
  });
  expect(await combinations(owner, "full", 0)).toMatchObject({
    combinations: [{ id, bookable: false, version: 1 }],
  });
  await t.db.update(service).set({ onlineBooking: true }).where(eq(service.id, f.colorId));
  const path = `/admin/services/combinations/${id}`;
  const current = {
    ...fields,
    name: "Cloud colour and cut",
    serviceIds: [f.colorId, f.haircutId],
  };
  expect((await json(t.app, path, "PUT", { ...current, version: 1 }, owner.cookie)).status).toBe(
    200,
  );
  const archive = (version: number, reviewed: typeof fields) =>
    mutation("combination.update", { ...reviewed, id, version, active: false });
  expect((await push(t, owner, [archive(1, fields)])).body.results[0]).toMatchObject({
    status: "rejected",
    reason: "conflict",
  });
  const reviewed = await combinations(owner, "full", 0);
  expect(reviewed).toMatchObject({ combinations: [{ id, ...current, version: 2 }] });
  expect(await combinations(owner, "delta", reviewed.headSeq)).not.toHaveProperty("combinations");
  expect((await push(t, owner, [archive(2, current)])).body.results[0]).toMatchObject({
    status: "applied",
    appliedSeq: expect.any(Number),
  });
  expect(await combinations(owner, "delta", reviewed.headSeq)).toMatchObject({
    combinations: [{ id, ...current, active: false, version: 3 }],
  });
  expect(await (await json(t.app, "/services/combinations", "GET")).json()).toEqual({
    combinations: [],
  });
  const afterArchive = await combinations(owner, "full", 0);
  await t.db.update(service).set({ active: false }).where(eq(service.id, f.colorId));
  expect(await combinations(owner, "delta", afterArchive.headSeq)).toMatchObject({
    combinations: [{ id, active: false, bookable: false, version: 3 }],
  });
});

test("native resource requirements are versioned, validated and replay safely", async () => {
  const path = `/admin/services/${f.haircutId}/resources`;
  const create = await json(
    t.app,
    "/admin/resources",
    "POST",
    { name: "Room A", kind: "room", capacity: 2, idempotencyKey: mid() },
    owner.cookie,
  );
  expect(create.status).toBe(201);
  const room = (await create.json()) as { id: string };
  const snapshot = await json(t.app, `${path}/reviewed`, "GET", undefined, owner.cookie);
  expect(snapshot.status).toBe(200);
  expect(await snapshot.json()).toMatchObject({
    generation: expect.any(String),
    resources: [expect.objectContaining({ id: room.id, capacity: 2 })],
    service: { serviceId: f.haircutId, version: 1, requirements: [] },
  });
  const save = (quantity: number, selectionMode = "all") => ({
    mutationId: mid(),
    createdAt: new Date().toISOString(),
    kind: "service.resources",
    payload: {
      id: f.haircutId,
      version: 1,
      selectionMode,
      requirements: [{ resourceId: room.id, quantity }],
    },
  });
  expect((await push(t, ana, [save(1)])).body.results[0]).toMatchObject({
    status: "rejected",
    reason: "forbidden",
  });
  expect((await push(t, owner, [save(2, "one_of")])).body.results[0]).toMatchObject({
    status: "rejected",
    reason: "invalid",
  });
  const valid = save(2);
  expect((await push(t, owner, [valid])).body.results[0]).toMatchObject({ status: "applied" });
  expect((await push(t, owner, [valid])).body.results[0]).toMatchObject({
    status: "applied",
    replayed: true,
  });
  expect((await push(t, owner, [save(1)])).body.results[0]).toMatchObject({
    status: "rejected",
    reason: "conflict",
  });
  const saved = await json(t.app, path, "GET", undefined, owner.cookie);
  expect(await saved.json()).toMatchObject({
    version: 2,
    requirements: [expect.objectContaining({ resourceId: room.id, quantity: 2 })],
  });
  expect((await pull(t, owner, { resourceCatalogue: "1" })).refresh).toContain(
    "resource_catalogue",
  );
  expect((await pull(t, owner)).refresh ?? []).not.toContain("resource_catalogue");
  expect((await pull(t, ana, { resourceCatalogue: "1" })).refresh ?? []).not.toContain(
    "resource_catalogue",
  );
  const retired = await json(
    t.app,
    `/admin/resources/${room.id}`,
    "PUT",
    { name: "Room A", kind: "room", capacity: 2, active: false, version: 1 },
    owner.cookie,
  );
  expect(retired.status).toBe(200);
  const stalePool = save(1);
  expect(
    (await push(t, owner, [{ ...stalePool, payload: { ...stalePool.payload, version: 2 } }])).body
      .results[0],
  ).toMatchObject({
    status: "rejected",
    reason: "invalid",
  });
  const clear = {
    ...save(1),
    payload: { ...save(1).payload, version: 2, requirements: [] },
  };
  expect((await push(t, owner, [clear])).body.results[0]).toMatchObject({ status: "applied" });
});

test("native resource pools replay once and cannot displace future reservations", async () => {
  const id = uuid();
  const settings = { name: "Reviewed room", kind: "room", capacity: 2 };
  const envelope = () => ({ mutationId: mid(), createdAt: new Date().toISOString() });
  const create = { ...envelope(), kind: "resource.create", payload: { id, ...settings } };
  expect((await push(t, ana, [create])).body.results[0]).toMatchObject({ reason: "forbidden" });
  const authorized = { ...create, ...envelope() };
  expect((await push(t, owner, [authorized])).body.results[0]).toMatchObject({
    status: "applied",
    appliedSeq: expect.any(Number),
  });
  expect((await push(t, owner, [authorized])).body.results[0]).toMatchObject({
    status: "applied",
    replayed: true,
  });
  const snapshots = await pull(t, owner, { resourcePools: "full" });
  expect(snapshots.resourcePools).toEqual([
    expect.objectContaining({ id, version: 1, active: true, capacity: 2 }),
  ]);
  expect((await pull(t, ana, { resourcePools: "full" })).resourcePools).toBeUndefined();
  expect((await pull(t, owner)).resourcePools).toBeUndefined();
  expect(
    (
      await json(
        t.app,
        `/admin/services/${f.haircutId}/resources`,
        "PUT",
        { version: 1, requirements: [{ resourceId: id, quantity: 2 }] },
        owner.cookie,
      )
    ).status,
  ).toBe(200);
  const booking = await push(t, owner, [createAppt()]);
  expect(booking.body.results[0]).toMatchObject({ status: "applied" });
  const update = (version: number, capacity: number, active: boolean, name = settings.name) => ({
    ...envelope(),
    kind: "resource.update",
    payload: { id, ...settings, version, capacity, active, name },
  });
  expect((await push(t, owner, [update(1, 1, true)])).body.results[0]).toMatchObject({
    status: "rejected",
  });
  expect((await push(t, owner, [update(1, 2, false)])).body.results[0]).toMatchObject({
    status: "rejected",
    reason: "invalid_state",
  });
  expect(
    (await push(t, owner, [update(1, 2, true, "Renamed room")])).body.results[0],
  ).toMatchObject({ status: "applied" });
  expect((await push(t, owner, [update(1, 3, true)])).body.results[0]).toMatchObject({
    reason: "conflict",
  });
  const after = await pull(t, owner, { resourcePools: "delta", since: snapshots.nextCursor });
  expect(after.resourcePools).toEqual([
    expect.objectContaining({ id, name: "Renamed room", version: 2, capacity: 2, active: true }),
  ]);
});

describe("authorization and envelope", () => {
  test("a restored generation rejects legacy and stale batches before writing or recording them", async () => {
    const restored = await setupApiTest({
      dbSuffix: "sync_recovery",
      env: { SYNC_REPLICA_GENERATION: "restored-20261118" },
    });
    try {
      await restored.reset();
      const fixtures = await seedFixtures(restored.db);
      const operator = await actor(restored, "owner", "recovery@example.com");
      const page = await pull(restored, operator);
      expect(page.generation).toBe("restored-20261118");
      const mutations = [
        mutation("appointment.create", {
          id: uuid(),
          staffId: fixtures.anaId,
          clientId: fixtures.clientId,
          serviceIds: [fixtures.haircutId],
          startsAt: MONDAY_0900,
        }),
      ];
      const send = (generation?: string) =>
        json(
          restored.app,
          "/sync/push",
          "POST",
          { deviceId: "offline", generation, mutations },
          operator.cookie,
        );
      for (const generation of [undefined, "initial", "another-restore"]) {
        const rejected = await send(generation);
        expect(rejected.status).toBe(409);
        expect(await errorCodeOf(rejected)).toBe("sync_generation_changed");
      }
      expect(await restored.db.select().from(appointment)).toHaveLength(0);
      expect(await restored.db.select().from(syncMutation)).toHaveLength(0);
      const accepted = await send(page.generation);
      expect(accepted.status).toBe(200);
      expect(await restored.db.select().from(appointment)).toHaveLength(1);
    } finally {
      await restored.close();
    }
  });

  test("anonymous is 401 and the client role is 403", async () => {
    expect((await push(t, null, [createAppt()])).status).toBe(401);
    const denied = await push(t, client, [createAppt()]);
    expect(denied.status).toBe(403);
    expect(await rows(sql`select 1 from appointment`)).toHaveLength(0);
  });

  test("rejects an empty batch, an oversized batch and a mutation without an id", async () => {
    expect((await push(t, owner, [])).status).toBe(400);
    const many = Array.from({ length: 101 }, () => createAppt());
    expect((await push(t, owner, many)).status).toBe(400);
    expect((await push(t, owner, [{ kind: "client.create" }])).status).toBe(400);
    const noDevice = await json(
      t.app,
      "/sync/push",
      "POST",
      { mutations: [createAppt()] },
      owner.cookie,
    );
    expect(noDevice.status).toBe(400);
    expect(await errorCodeOf(noDevice)).toBe("validation_error");
  });

  test("a malformed mutation is rejected as invalid without failing its neighbours", async () => {
    const bad = { mutationId: mid(), kind: "appointment.explode", payload: {} };
    const alsoBad = mutation("appointment.cancel", { id: "not-a-uuid" as never, version: 1 });
    const { body } = await push(t, owner, [
      createAppt(),
      bad,
      alsoBad,
      createAppt({ staffId: f.beaId }),
    ]);
    expect(body.results.map((r) => r.status)).toEqual([
      "applied",
      "rejected",
      "rejected",
      "applied",
    ]);
    expect(body.results[1]).toMatchObject({ mutationId: bad.mutationId, reason: "invalid" });
    expect(body.results[2]).toMatchObject({ reason: "invalid" });
  });
});

describe("idempotency", () => {
  test("replaying a mutation returns the stored result and never applies twice", async () => {
    const m = createAppt();
    const first = await push(t, owner, [m]);
    const second = await push(t, owner, [m]);
    const a = first.body.results[0];
    const b = second.body.results[0];
    expect(a).toMatchObject({ status: "applied", replayed: false });
    expect(b).toMatchObject({ status: "applied", replayed: true });
    if (a?.status !== "applied" || b?.status !== "applied") throw new Error("unexpected");
    expect(b.appliedSeq).toBe(a.appliedSeq);
    expect(a.appliedSeq).not.toBeNull();
    expect(await t.db.select().from(appointment)).toHaveLength(1);
    expect(await t.db.select().from(syncMutation)).toHaveLength(1);
  });

  test("the same batch delivered twice is a no-op the second time", async () => {
    const batch = [createAppt(), createAppt({ staffId: f.beaId, startsAt: MONDAY_1400 })];
    await push(t, owner, batch);
    const before = await pull(t, owner, { since: 0, limit: 500 });
    const again = await push(t, owner, batch);
    expect(again.body.results.every((r) => r.status === "applied" && r.replayed)).toBe(true);
    const after = await pull(t, owner, { since: 0, limit: 500 });
    expect(after.headSeq).toBe(before.headSeq);
    expect(await t.db.select().from(appointment)).toHaveLength(2);
  });

  test("the same mutation twice inside one batch applies once", async () => {
    const m = createAppt();
    const { body } = await push(t, owner, [m, m]);
    expect(body.results.map((r) => (r.status === "applied" ? r.replayed : null))).toEqual([
      false,
      true,
    ]);
    expect(await t.db.select().from(appointment)).toHaveLength(1);
  });

  test("concurrent deliveries of the same mutation apply exactly once", async () => {
    const m = createAppt();
    const responses = await Promise.all(Array.from({ length: 6 }, () => push(t, owner, [m])));
    const results = responses.map((r) => r.body.results[0]);
    expect(results.every((r) => r?.status === "applied")).toBe(true);
    const fresh = results.filter((r) => r?.status === "applied" && !r.replayed);
    expect(fresh).toHaveLength(1);
    expect(await t.db.select().from(appointment)).toHaveLength(1);
  });

  test("a stored rejection is replayed verbatim even after the slot frees up", async () => {
    const blocker = createAppt({ id: uuid() });
    await push(t, owner, [blocker]);
    const loser = createAppt();
    const first = await push(t, owner, [loser]);
    expect(first.body.results[0]).toMatchObject({
      status: "rejected",
      reason: "slot_taken",
      replayed: false,
    });

    await push(t, owner, [mutation("appointment.cancel", { id: blocker.payload.id, version: 1 })]);
    const replay = await push(t, owner, [loser]);
    expect(replay.body.results[0]).toMatchObject({
      status: "rejected",
      reason: "slot_taken",
      replayed: true,
      message: first.body.results[0]?.status === "rejected" ? first.body.results[0].message : "",
    });
    expect(
      await t.db.select().from(appointment).where(eq(appointment.id, loser.payload.id)),
    ).toHaveLength(0);
  });

  test("a mutation id cannot be borrowed by another user", async () => {
    const m = createAppt({ staffId: f.anaId });
    await push(t, ana, [m]);
    const stolen = await push(t, bea, [m]);
    expect(stolen.body.results[0]).toMatchObject({ status: "rejected", reason: "invalid" });
  });
});

describe("ordering", () => {
  test("mutations in a batch are applied in order (create, then move it)", async () => {
    const create = createAppt();
    const move = mutation("appointment.reschedule", {
      id: create.payload.id,
      version: 1,
      startsAt: MONDAY_1400,
    });
    const cancel = mutation("appointment.cancel", { id: create.payload.id, version: 2 });
    const { body } = await push(t, owner, [create, move, cancel]);
    expect(body.results.map((r) => r.status)).toEqual(["applied", "applied", "applied"]);
    const [row] = await t.db
      .select()
      .from(appointment)
      .where(eq(appointment.id, create.payload.id));
    expect(row?.status).toBe("cancelled");
    expect(row?.startsAt.toISOString()).toBe(MONDAY_1400);
    expect(row?.version).toBe(3);
  });

  test("out of order: a dependent mutation that arrives first is rejected, not dropped", async () => {
    const create = createAppt();
    const move = mutation("appointment.reschedule", {
      id: create.payload.id,
      version: 1,
      startsAt: MONDAY_1400,
    });
    const early = await push(t, owner, [move]);
    expect(early.body.results[0]).toMatchObject({ status: "rejected", reason: "not_found" });

    await push(t, owner, [create]);
    // Rejections are final; the client resends with a NEW mutation id once the parent is known.
    const replayedRejection = await push(t, owner, [move]);
    expect(replayedRejection.body.results[0]).toMatchObject({ status: "rejected", replayed: true });
    const retry = mutation("appointment.reschedule", move.payload);
    const done = await push(t, owner, [retry]);
    expect(done.body.results[0]).toMatchObject({ status: "applied" });
    const [row] = await t.db
      .select()
      .from(appointment)
      .where(eq(appointment.id, create.payload.id));
    expect(row?.startsAt.toISOString()).toBe(MONDAY_1400);
  });

  test("independent batches may arrive in any order", async () => {
    const a = createAppt({ staffId: f.anaId });
    const b = createAppt({ staffId: f.beaId });
    await push(t, owner, [b]);
    await push(t, owner, [a]);
    expect(await t.db.select().from(appointment)).toHaveLength(2);
  });

  test("distinct mutations pushed concurrently all land without deadlocks", async () => {
    const starts = [
      "2026-03-09T12:00:00.000Z",
      "2026-03-09T13:00:00.000Z",
      "2026-03-09T14:00:00.000Z",
      "2026-03-09T15:00:00.000Z",
    ];
    const batches = starts.flatMap((startsAt) => [
      push(t, owner, [createAppt({ staffId: f.anaId, startsAt })]),
      push(t, owner, [createAppt({ staffId: f.beaId, startsAt })]),
      push(t, owner, [mutation("client.create", { id: uuid(), name: `Walk-in ${startsAt}` })]),
    ]);
    const responses = await Promise.all(batches);
    expect(responses.flatMap((r) => r.body.results).every((r) => r.status === "applied")).toBe(
      true,
    );
    expect(await countOverlaps(t.db)).toBe(0);
  });
});

describe("appointments are server-authoritative", () => {
  test("an overlapping booking is rejected with slot_taken and surfaced, never dropped", async () => {
    const winner = createAppt();
    const loser = createAppt({ startsAt: "2026-03-09T12:30:00.000Z" });
    const { body } = await push(t, owner, [winner, loser]);
    expect(body.results[0]?.status).toBe("applied");
    expect(body.results[1]).toMatchObject({
      status: "rejected",
      reason: "slot_taken",
      mutationId: loser.mutationId,
    });
    expect(await t.db.select().from(appointment)).toHaveLength(1);
    expect(await countOverlaps(t.db)).toBe(0);
    const stored = await t.db
      .select()
      .from(syncMutation)
      .where(eq(syncMutation.mutationId, loser.mutationId));
    expect(stored[0]).toMatchObject({ status: "rejected", appliedSeq: null });
  });

  test("outside working hours is slot_unavailable", async () => {
    const early = createAppt({ startsAt: "2026-03-09T08:00:00.000Z" });
    const { body } = await push(t, owner, [early]);
    expect(body.results[0]).toMatchObject({ status: "rejected", reason: "slot_unavailable" });
  });

  test("a stale version is a conflict, a closed appointment is invalid_state", async () => {
    const create = createAppt();
    await push(t, owner, [create]);
    const stale = mutation("appointment.reschedule", {
      id: create.payload.id,
      version: 7,
      startsAt: MONDAY_1400,
    });
    const cancel = mutation("appointment.cancel", { id: create.payload.id, version: 1 });
    const afterCancel = mutation("appointment.reschedule", {
      id: create.payload.id,
      version: 2,
      startsAt: MONDAY_1400,
    });
    const { body } = await push(t, owner, [stale, cancel, afterCancel]);
    expect(body.results[0]).toMatchObject({ status: "rejected", reason: "conflict" });
    expect(body.results[1]).toMatchObject({ status: "applied" });
    expect(body.results[2]).toMatchObject({ status: "rejected", reason: "invalid_state" });
  });

  test("an appointment cannot be marked completed before it starts", async () => {
    const create = createAppt();
    await push(t, owner, [create]);
    const { body } = await push(t, owner, [
      mutation("appointment.set_status", {
        id: create.payload.id,
        version: 1,
        status: "completed",
      }),
    ]);
    expect(body.results[0]).toMatchObject({ status: "rejected", reason: "invalid_state" });
  });

  test("an unknown appointment is not_found", async () => {
    const { body } = await push(t, owner, [
      mutation("appointment.cancel", { id: uuid(), version: 1 }),
    ]);
    expect(body.results[0]).toMatchObject({ status: "rejected", reason: "not_found" });
  });

  test("staff may only write to their own calendar", async () => {
    const own = createAppt({ staffId: f.anaId });
    const other = createAppt({ staffId: f.beaId, startsAt: MONDAY_1400 });
    const { body } = await push(t, ana, [own, other]);
    expect(body.results[0]?.status).toBe("applied");
    expect(body.results[1]).toMatchObject({ status: "rejected", reason: "forbidden" });

    const theirs = createAppt({ staffId: f.beaId });
    await push(t, bea, [theirs]);
    const cancel = await push(t, ana, [
      mutation("appointment.cancel", { id: theirs.payload.id, version: 1 }),
    ]);
    expect(cancel.body.results[0]).toMatchObject({ status: "rejected", reason: "forbidden" });
  });

  test("an inline client is created together with the booking and both reach pull", async () => {
    const m = mutation("appointment.create", {
      id: uuid(),
      staffId: f.anaId,
      serviceIds: [f.haircutId],
      startsAt: MONDAY_0900,
      client: { name: "Walk In", phone: "+54 9 11 5555 0000" },
    });
    const { body } = await push(t, owner, [m]);
    expect(body.results[0]?.status).toBe("applied");
    const { changes } = await pullAll(t, owner);
    expect(
      changes.some((c) => c.entity === "client" && c.op === "upsert" && c.data?.name === "Walk In"),
    ).toBe(true);
    expect(changes.some((c) => c.entity === "appointment" && c.id === m.payload.id)).toBe(true);
  });

  test("appliedSeq points at the change the mutation produced", async () => {
    const m = createAppt();
    const { body } = await push(t, owner, [m]);
    const result = body.results[0];
    if (result?.status !== "applied" || result.appliedSeq === null) throw new Error("unexpected");
    const { changes } = await pullAll(t, owner);
    const change = changes.find((c) => c.entity === "appointment" && c.id === m.payload.id);
    expect(change?.seq).toBe(result.appliedSeq);
    expect(body.headSeq).toBeGreaterThanOrEqual(result.appliedSeq);
  });
});

describe("clients and last-writer-wins", () => {
  async function setUpdatedAt(id: string, at: string) {
    await t.db.execute(sql`update client_profile set updated_at = ${at} where id = ${id}`);
  }
  const clientRow = async (id: string) =>
    (await t.db.select().from(clientProfile).where(eq(clientProfile.id, id)))[0];

  test("create then edit notes", async () => {
    const id = uuid();
    const { body } = await push(t, ana, [
      mutation(
        "client.create",
        { id, name: "Maria", email: "maria@example.com", notes: "first" },
        { createdAt: ago(2_000) },
      ),
      mutation("client.update", { id, notes: "second" }, { createdAt: ago(1_000) }),
    ]);
    expect(body.results.map((r) => r.status)).toEqual(["applied", "applied"]);
    expect((await clientRow(id))?.notes).toBe("second");
  });

  test("a newer offline edit wins and keeps its own edit time", async () => {
    const id = f.clientId;
    await setUpdatedAt(id, ago(3_600_000));
    const editedAt = ago(60_000);
    const { body } = await push(t, ana, [
      mutation("client.update", { id, notes: "from desktop" }, { createdAt: editedAt }),
    ]);
    expect(body.results[0]?.status).toBe("applied");
    const row = await clientRow(id);
    expect(row?.notes).toBe("from desktop");
    expect(row?.updatedAt.toISOString()).toBe(editedAt);
  });

  test("an older offline edit loses to what the server already has, and says so", async () => {
    const id = f.clientId;
    await call(owner, "PATCH", `/admin/clients/${id}`, { notes: "web edit" });
    const stale = mutation(
      "client.update",
      { id, notes: "offline edit" },
      { createdAt: ago(3_600_000) },
    );
    const { body } = await push(t, ana, [stale]);
    expect(body.results[0]).toMatchObject({ status: "rejected", reason: "conflict" });
    expect((await clientRow(id))?.notes).toBe("web edit");
  });

  test("an offline contact edit cannot overwrite a newer contact state it never reviewed", async () => {
    const id = f.clientId;
    const baseline = ago(3_600_000);
    await setUpdatedAt(id, baseline);
    const first = await push(t, ana, [
      mutation(
        "client.update",
        { id, expectedUpdatedAt: baseline, notes: "Reviewed edit" },
        { createdAt: ago(120_000) },
      ),
    ]);
    expect(first.body.results[0]?.status).toBe("applied");

    const second = await push(t, bea, [
      mutation(
        "client.update",
        { id, expectedUpdatedAt: baseline, notes: "Unreviewed edit from a later clock" },
        { createdAt: ago(30_000) },
      ),
    ]);
    expect(second.body.results[0]).toMatchObject({ status: "rejected", reason: "conflict" });
    expect((await clientRow(id))?.notes).toBe("Reviewed edit");
  });

  test("two devices editing offline: the later edit wins regardless of arrival order", async () => {
    const id = f.clientId;
    await setUpdatedAt(id, ago(3_600_000_0));
    const earlier = mutation(
      "client.update",
      { id, notes: "device A" },
      { createdAt: ago(200_000) },
    );
    const later = mutation("client.update", { id, notes: "device B" }, { createdAt: ago(100_000) });
    const first = await push(t, ana, [later], "device-b");
    const second = await push(t, ana, [earlier], "device-a");
    expect(first.body.results[0]?.status).toBe("applied");
    expect(second.body.results[0]).toMatchObject({ status: "rejected", reason: "conflict" });
    expect((await clientRow(id))?.notes).toBe("device B");
  });

  test("an exact timestamp tie is decided deterministically: the server keeps its row", async () => {
    const id = f.clientId;
    const at = ago(120_000);
    await setUpdatedAt(id, at);
    const { body } = await push(t, ana, [
      mutation("client.update", { id, notes: "tie" }, { createdAt: at }),
    ]);
    expect(body.results[0]).toMatchObject({ status: "rejected", reason: "conflict" });
  });

  test("a device clock in the future is clamped to server time", async () => {
    const id = f.clientId;
    await setUpdatedAt(id, ago(3_600_000));
    const future = new Date(Date.now() + 365 * 86_400_000).toISOString();
    await push(t, ana, [mutation("client.update", { id, notes: "future" }, { createdAt: future })]);
    const row = await clientRow(id);
    expect(row?.notes).toBe("future");
    expect(row?.updatedAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  test("a creation replayed under a new mutation id behaves like an edit, a tombstone is not resurrected", async () => {
    const id = uuid();
    await push(t, ana, [mutation("client.create", { id, name: "Once" })]);
    const again = await push(t, ana, [
      mutation(
        "client.create",
        { id, name: "Twice" },
        { createdAt: new Date(Date.now() + 5).toISOString() },
      ),
    ]);
    expect(again.body.results[0]?.status).toBe("applied");
    expect((await clientRow(id))?.name).toBe("Twice");
    await call(owner, "DELETE", `/admin/clients/${id}`);
    const resurrect = await push(t, ana, [mutation("client.update", { id, name: "Zombie" })]);
    expect(resurrect.body.results[0]).toMatchObject({ status: "rejected", reason: "not_found" });
    expect((await clientRow(id))?.deletedAt).not.toBeNull();
  });

  test("a client create with an invalid email is rejected as invalid", async () => {
    const { body } = await push(t, ana, [
      mutation("client.create", { id: uuid(), name: "X", email: "nope" }),
    ]);
    expect(body.results[0]).toMatchObject({ status: "rejected", reason: "invalid" });
  });
});

describe("other last-writer-wins entities and tombstones", () => {
  test("time off: create, edit, delete propagate (tombstone included)", async () => {
    const id = uuid();
    const cursor = (await pull(t, owner)).headSeq;
    const { body } = await push(t, ana, [
      mutation(
        "time_off.create",
        {
          id,
          staffId: f.anaId,
          startsAt: "2026-03-12T12:00:00.000Z",
          endsAt: "2026-03-12T14:00:00.000Z",
        },
        { createdAt: ago(3_000) },
      ),
      mutation(
        "time_off.update",
        { id, staffId: f.anaId, reason: "dentist" },
        { createdAt: ago(2_000) },
      ),
      mutation("time_off.delete", { id, staffId: f.anaId }, { createdAt: ago(1_000) }),
    ]);
    expect(body.results.map((r) => r.status)).toEqual(["applied", "applied", "applied"]);
    const page = await pull(t, owner, { since: cursor });
    expect(page.changes.filter((c) => c.entity === "time_off")).toEqual([
      { seq: expect.any(Number), entity: "time_off", id, op: "delete", data: null },
    ]);
    const [row] = await t.db.select().from(timeOff).where(eq(timeOff.id, id));
    expect(row?.deletedAt).not.toBeNull();
  });

  test("staff cannot touch another calendar's time off", async () => {
    const { body } = await push(t, ana, [
      mutation("time_off.create", {
        id: uuid(),
        staffId: f.beaId,
        startsAt: "2026-03-12T12:00:00.000Z",
        endsAt: "2026-03-12T14:00:00.000Z",
      }),
    ]);
    expect(body.results[0]).toMatchObject({ status: "rejected", reason: "forbidden" });
  });

  test("service, staff and settings edits are owner-only and last-writer-wins", async () => {
    const edit = (kind: "service.update" | "staff.update" | "settings.update") => {
      if (kind === "service.update") return mutation(kind, { id: f.haircutId, priceCents: 12345 });
      if (kind === "staff.update") return mutation(kind, { id: f.beaId, displayName: "Beatriz" });
      return mutation(kind, { minNoticeMinutes: 5 });
    };
    const kinds = ["service.update", "staff.update", "settings.update"] as const;
    const denied = await push(t, ana, kinds.map(edit));
    expect(
      denied.body.results.every((r) => r.status === "rejected" && r.reason === "forbidden"),
    ).toBe(true);

    const ok = await push(t, owner, kinds.map(edit));
    expect(ok.body.results.map((r) => r.status)).toEqual(["applied", "applied", "applied"]);
    const [svc] = await t.db.select().from(service).where(eq(service.id, f.haircutId));
    const [bea2] = await t.db.select().from(staffProfile).where(eq(staffProfile.id, f.beaId));
    const [settings] = await t.db.select().from(salonSettings);
    expect(svc?.priceCents).toBe(12345);
    expect(bea2?.displayName).toBe("Beatriz");
    expect(settings?.minNoticeMinutes).toBe(5);
  });

  test("an older service edit than the stored row is a conflict", async () => {
    const stale = mutation(
      "service.update",
      { id: f.haircutId, priceCents: 1 },
      { createdAt: "2020-01-01T00:00:00.000Z" },
    );
    const { body } = await push(t, owner, [stale]);
    expect(body.results[0]).toMatchObject({ status: "rejected", reason: "conflict" });
  });

  test("reviewed service assignments sync without erasing a concurrent team edit", async () => {
    const assign = (reviewedStaffIds: string[], staffIds: string[]) =>
      mutation("service.staff_replace", { id: f.haircutId, reviewedStaffIds, staffIds });
    const read = async () => {
      const response = await call(owner, "GET", "/admin/services");
      expect(response.status).toBe(200);
      const { services } = listAdminServicesResponseSchema.parse(await response.json());
      const saved = services.find((row) => row.id === f.haircutId);
      if (!saved) throw new Error("Missing fixture service");
      return saved.staffIds;
    };
    const initial = [f.beaId, f.anaId];
    const queued = assign(initial, [f.anaId]);
    const cursor = (await pull(t, owner)).headSeq;
    expect((await push(t, ana, [assign(initial, [f.anaId])])).body.results[0]).toMatchObject({
      status: "rejected",
      reason: "forbidden",
    });
    expect((await push(t, owner, [queued])).body.results[0]).toMatchObject({ status: "applied" });
    expect(await read()).toEqual([f.anaId]);
    expect((await pull(t, ana, { since: cursor })).changes).toContainEqual(
      expect.objectContaining({ entity: "service_staff", op: "delete" }),
    );
    expect((await push(t, owner, [queued])).body.results[0]).toMatchObject({
      status: "applied",
      replayed: true,
    });
    expect((await push(t, owner, [assign(initial, [])])).body.results[0]).toMatchObject({
      status: "rejected",
      reason: "conflict",
    });
    expect(await read()).toEqual([f.anaId]);
    await t.db.update(staffProfile).set({ active: false }).where(eq(staffProfile.id, f.anaId));
    expect(
      (await push(t, owner, [assign([f.anaId], [f.anaId, f.beaId])])).body.results[0],
    ).toMatchObject({
      status: "applied",
    });
    expect(new Set(await read())).toEqual(new Set(initial));
  });

  test("a reviewed variant can be booked after its queued assignment without changing the quote", async () => {
    const created = await call(owner, "POST", "/admin/services", {
      name: "Extended haircut",
      durationMinutes: 45,
      priceCents: 12500,
      currency: "ARS",
      staffIds: [f.beaId],
      catalog: { kind: "variant", parentServiceId: f.haircutId, optionLabel: "Extended" },
    });
    expect(created.status).toBe(201);
    const variant = adminServiceSchema.parse(await created.json());
    const variants = (await pullAll(t, owner)).changes;
    const reviewed = serviceSchema.parse(
      variants.find((entry) => entry.entity === "service" && entry.id === variant.id)?.data,
    );
    if (!reviewed.quoteHash) throw new Error("Missing reviewed variant quote");
    const startsAt = MONDAY_0900;
    const id = uuid();
    const result = await push(t, owner, [
      mutation("service.staff_replace", {
        id: variant.id,
        reviewedStaffIds: [f.beaId],
        staffIds: [f.anaId],
      }),
      mutation("appointment.create", {
        id,
        staffId: f.anaId,
        clientId: f.clientId,
        serviceIds: [variant.id],
        serviceQuotes: { [variant.id]: reviewed.quoteHash },
        startsAt,
      }),
    ]);
    expect(result.body.results.map((entry) => entry.status)).toEqual(["applied", "applied"]);
    expect(await t.db.select().from(appointment).where(eq(appointment.id, id))).toHaveLength(1);
  });

  test("a reviewed settings edit replays safely and cannot overwrite a newer Cloud revision", async () => {
    const read = async () =>
      desktopSalonSettingsSchema.parse(
        await (await call(owner, "GET", "/admin/settings/desktop")).json(),
      );
    const { revision, minNoticeMinutes } = await read();
    const cursor = (await pull(t, owner)).headSeq;
    const queued = mutation(
      "settings.update",
      { expectedRevision: revision, changes: { onlineBookingEnabled: false } },
      { createdAt: "2020-01-01T00:00:00.000Z" },
    );
    const staff = mutation("settings.update", {
      expectedRevision: revision,
      changes: { minNoticeMinutes: 70 },
    });
    expect((await push(t, ana, [staff])).body.results[0]).toMatchObject({
      status: "rejected",
      reason: "forbidden",
    });
    expect((await push(t, owner, [queued])).body.results[0]).toMatchObject({ status: "applied" });
    expect(await read()).toMatchObject({ onlineBookingEnabled: false });
    const ownerChanges = (await pull(t, owner, { since: cursor })).changes;
    expect(ownerChanges.find((change) => change.entity === "salon_settings")).toMatchObject({
      data: {
        onlineBookingEnabled: false,
        ownerConfiguration: { onlineBookingEnabled: false, reminderFirstLeadMinutes: 1440 },
      },
    });
    const staffChanges = (await pull(t, ana, { since: cursor })).changes;
    expect(staffChanges.find((change) => change.entity === "salon_settings")?.data).toMatchObject({
      ownerConfiguration: null,
    });
    expect(
      (await call(owner, "PATCH", "/admin/settings", { onlineBookingEnabled: true })).status,
    ).toBe(200);
    const reopened = await read();
    expect((await push(t, owner, [queued])).body.results[0]).toMatchObject({
      status: "applied",
      replayed: true,
    });
    const stale = mutation("settings.update", {
      expectedRevision: revision,
      changes: { onlineBookingEnabled: false, minNoticeMinutes: minNoticeMinutes === 70 ? 80 : 70 },
    });
    expect((await push(t, owner, [stale])).body.results[0]).toMatchObject({
      status: "rejected",
      reason: "conflict",
    });
    expect(await read()).toEqual(reopened);
  });

  test("a business rule of the admin layer still applies (cannot deactivate staff with future bookings)", async () => {
    await push(t, owner, [createAppt()]);
    const { body } = await push(t, owner, [
      mutation("staff.update", { id: f.anaId, active: false }),
    ]);
    expect(body.results[0]).toMatchObject({ status: "rejected", reason: "invalid_state" });
  });
});

describe("pull after push", () => {
  test("pushed changes appear in pull with the client-assigned ids", async () => {
    const id = uuid();
    const cursor = (await pull(t, owner)).headSeq;
    await push(t, owner, [createAppt({ id })]);
    const page = await pull(t, owner, { since: cursor });
    expect(page.changes.map((c) => `${c.entity}:${c.id}`)).toContain(`appointment:${id}`);
  });
});

function call(who: Actor, method: string, path: string, body?: unknown) {
  return json(t.app, path, method, body, who.cookie);
}
