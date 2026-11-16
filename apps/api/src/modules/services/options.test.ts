import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
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
beforeAll(async () => {
  t = await setupApiTest({ dbSuffix: "catalog_options" });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  f = await seedFixtures(t.db);
  [owner, client] = await Promise.all([
    actor(t, "owner", "owner@catalog-options.test"),
    actor(t, "client", "client@catalog-options.test"),
  ]);
});
const call = (path: string, method = "GET", body?: unknown, who = owner) =>
  json(t.app, path, method, body, who.cookie);
async function create(catalog: unknown, extra = {}) {
  const r = await call("/admin/services", "POST", {
    name: "Haircut · Long hair",
    durationMinutes: 60,
    priceCents: 15000,
    catalog,
    ...extra,
  });
  expect(r.status, await r.clone().text()).toBe(201);
  return (await r.json()) as {
    id: string;
    staffIds: string[];
    catalog: {
      kind: string;
      version: number;
      parentServiceId?: string;
      optionLabel?: string;
      allowedServiceIds?: string[];
    };
  };
}
const book = (serviceIds: string[]) =>
  call("/appointments", "POST", {
    staffId: f.anaId,
    clientId: f.clientId,
    serviceIds,
    startsAt: "2026-03-09T12:00:00.000Z",
  });
test("a variant inherits the initial performers, has its own price and excludes other choices in its family", async () => {
  const variant = await create({
    kind: "variant",
    parentServiceId: f.haircutId,
    optionLabel: "Long hair",
  });
  expect(variant.catalog).toMatchObject({
    kind: "variant",
    parentServiceId: f.haircutId,
    optionLabel: "Long hair",
    version: 1,
  });
  expect(variant.staffIds.sort()).toEqual([f.anaId, f.beaId].sort());
  const other = await create(
    { kind: "variant", parentServiceId: f.haircutId, optionLabel: "Short hair" },
    { name: "Haircut · Short hair" },
  );
  expect((await book([f.haircutId, variant.id])).status).toBe(400);
  expect((await book([variant.id, other.id])).status).toBe(400);
  const r = await book([variant.id]);
  expect(r.status, await r.clone().text()).toBe(201);
  expect(await r.json()).toMatchObject({
    endsAt: "2026-03-09T13:15:00.000Z",
    services: [{ priceCents: 15000, durationMinutes: 60, bufferMinutes: 15 }],
  });
});
test("add-ons require an eligible preceding service and one family selection permits its explicitly allowed extras", async () => {
  const addon = await create(
    { kind: "addon", allowedServiceIds: [f.haircutId] },
    { name: "Conditioning", durationMinutes: 10, priceCents: 1000 },
  );
  expect(addon.catalog).toMatchObject({
    kind: "addon",
    allowedServiceIds: [f.haircutId],
    version: 1,
  });
  expect((await book([addon.id])).status).toBe(400);
  expect((await book([f.colorId, addon.id])).status).toBe(400);
  expect((await book([addon.id, f.haircutId])).status).toBe(400);
  const r = await book([f.haircutId, addon.id]);
  expect(r.status, await r.clone().text()).toBe(201);
  expect(await r.json()).toMatchObject({
    endsAt: "2026-03-09T13:10:00.000Z",
    services: [{ priceCents: 10000 }, { priceCents: 1000 }],
  });
});
test("a price-only add-on preserves the visit window and cannot turn an ordinary service into a zero-minute booking", async () => {
  const addon = await create(
    { kind: "addon", allowedServiceIds: [f.haircutId] },
    { name: "Finish", durationMinutes: 0, priceCents: 500 },
  );
  const r = await book([f.haircutId, addon.id]);
  expect(r.status, await r.clone().text()).toBe(201);
  expect(await r.json()).toMatchObject({
    endsAt: "2026-03-09T13:00:00.000Z",
    services: [{ durationMinutes: 45 }, { durationMinutes: 0 }],
  });
  expect(
    (await call(`/admin/services/${f.haircutId}`, "PATCH", { durationMinutes: 0 })).status,
  ).toBe(400);
});
test("catalog relationships are restricted, bounded, revisioned and cannot form nested variants", async () => {
  const variant = await create({
    kind: "variant",
    parentServiceId: f.haircutId,
    optionLabel: "Long hair",
  });
  expect(
    (
      await call("/admin/services", "POST", {
        name: "Nested",
        durationMinutes: 10,
        priceCents: 500,
        catalog: { kind: "variant", parentServiceId: variant.id, optionLabel: "Nested" },
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await call(
        `/admin/services/${variant.id}/catalog`,
        "PUT",
        { kind: "variant", version: 1, optionLabel: "Updated" },
        client,
      )
    ).status,
  ).toBe(403);
  const r = await call(`/admin/services/${variant.id}/catalog`, "PUT", {
    kind: "variant",
    version: 1,
    optionLabel: "Updated",
  });
  expect(r.status, await r.clone().text()).toBe(200);
  expect(await r.json()).toMatchObject({ catalog: { version: 2, optionLabel: "Updated" } });
  expect(
    (
      await call(`/admin/services/${variant.id}/catalog`, "PUT", {
        kind: "variant",
        version: 1,
        optionLabel: "Stale",
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await call(`/admin/services/${variant.id}/catalog`, "PUT", {
        kind: "addon",
        version: 2,
        allowedServiceIds: [f.haircutId],
      })
    ).status,
  ).toBe(400);
});

test("variants copy their parent's initial resource requirements while zero-time add-ons cannot claim a room", async () => {
  const r = await call("/admin/resources", "POST", {
    name: "Room",
    kind: "room",
    capacity: 1,
    idempotencyKey: crypto.randomUUID(),
  });
  const room = (await r.json()) as { id: string };
  expect(
    (
      await call(`/admin/services/${f.haircutId}/resources`, "PUT", {
        version: 1,
        requirements: [{ resourceId: room.id, quantity: 1 }],
      })
    ).status,
  ).toBe(200);
  const variant = await create({
    kind: "variant",
    parentServiceId: f.haircutId,
    optionLabel: "Long hair",
  });
  expect(await (await call(`/admin/services/${variant.id}/resources`)).json()).toMatchObject({
    version: 1,
    requirements: [{ resourceId: room.id, quantity: 1 }],
  });
  const addon = await create(
    { kind: "addon", allowedServiceIds: [f.haircutId] },
    { name: "Finish", durationMinutes: 0 },
  );
  expect(
    (
      await call(`/admin/services/${addon.id}/resources`, "PUT", {
        version: 1,
        requirements: [{ resourceId: room.id, quantity: 1 }],
      })
    ).status,
  ).toBe(400);
});
test("an add-on with a resource requirement cannot be edited into a zero-length allocation", async () => {
  const addon = await create(
    { kind: "addon", allowedServiceIds: [f.haircutId] },
    { name: "Conditioning", durationMinutes: 10 },
  );
  const r = await call("/admin/resources", "POST", {
    name: "Equipment",
    kind: "equipment",
    capacity: 1,
    idempotencyKey: crypto.randomUUID(),
  });
  const pool = (await r.json()) as { id: string };
  expect(
    (
      await call(`/admin/services/${addon.id}/resources`, "PUT", {
        version: 1,
        requirements: [{ resourceId: pool.id, quantity: 1 }],
      })
    ).status,
  ).toBe(200);
  expect(
    (await call(`/admin/services/${addon.id}`, "PATCH", { durationMinutes: 0, bufferMinutes: 0 }))
      .status,
  ).toBe(400);
});

test("service creation assigns the reviewed team atomically and invalid performers leave no partial service", async () => {
  const failed = await call("/admin/services", "POST", {
    name: "Atomic",
    durationMinutes: 15,
    priceCents: 1000,
    staffIds: [crypto.randomUUID()],
  });
  expect(failed.status).toBe(404);
  expect(
    ((await (await call("/admin/services")).json()) as { services: unknown[] }).services,
  ).toHaveLength(2);
  const result = await create(
    { kind: "variant", parentServiceId: f.haircutId, optionLabel: "Selected team" },
    { staffIds: [f.beaId] },
  );
  expect(result.staffIds).toEqual([f.beaId]);
});

test("editing service details, team and option terms is atomic and rejects stale configuration", async () => {
  const variant = await create({
    kind: "variant",
    parentServiceId: f.haircutId,
    optionLabel: "Long hair",
  });
  const input = {
    version: 1,
    service: { name: "Haircut · Updated", priceCents: 18000 },
    staffIds: [crypto.randomUUID()],
    catalog: { kind: "variant", version: 1, optionLabel: "Updated" },
  };
  expect((await call(`/admin/services/${variant.id}/configuration`, "PUT", input)).status).toBe(
    404,
  );
  const unchanged = (
    (await (await call("/admin/services")).json()) as {
      services: { id: string; name: string; priceCents: number }[];
    }
  ).services.find((s) => s.id === variant.id);
  expect(unchanged).toMatchObject({ name: "Haircut · Long hair", priceCents: 15000 });
  const r = await call(`/admin/services/${variant.id}/configuration`, "PUT", {
    ...input,
    staffIds: [f.anaId],
  });
  expect(r.status, await r.clone().text()).toBe(200);
  expect(await r.json()).toMatchObject({
    name: "Haircut · Updated",
    priceCents: 18000,
    staffIds: [f.anaId],
    catalog: { optionLabel: "Updated" },
  });
  expect(
    (
      await call(`/admin/services/${variant.id}/configuration`, "PUT", {
        ...input,
        staffIds: [f.anaId],
      })
    ).status,
  ).toBe(409);
});

test("changing an extra's eligibility withdraws an unusable held waitlist offer and releases its room", async () => {
  const resource = await call("/admin/resources", "POST", {
    name: "Room",
    kind: "room",
    capacity: 1,
    idempotencyKey: crypto.randomUUID(),
  });
  const pool = (await resource.json()) as { id: string };
  expect(
    (
      await call(`/admin/services/${f.haircutId}/resources`, "PUT", {
        version: 1,
        requirements: [{ resourceId: pool.id, quantity: 1 }],
      })
    ).status,
  ).toBe(200);
  const addon = await create(
    { kind: "addon", allowedServiceIds: [f.haircutId] },
    { name: "Finish", durationMinutes: 0 },
  );
  expect(
    (await call("/admin/waitlist/policy", "PUT", { version: 1, enabled: true, offerMinutes: 30 }))
      .status,
  ).toBe(200);
  const joined = await call(
    "/me/waitlist",
    "POST",
    {
      serviceIds: [f.haircutId, addon.id],
      staffId: f.anaId,
      fromDate: "2026-03-09",
      toDate: "2026-03-09",
      fromTime: "09:00",
      toTime: "10:00",
      idempotencyKey: crypto.randomUUID(),
    },
    client,
  );
  expect(joined.status, await joined.clone().text()).toBe(201);
  const entry = (await joined.json()) as { id: string };
  await runWaitlist(t.db, { now: NOW });
  expect((await book([f.haircutId])).status).toBe(409);
  expect(
    (
      await call(`/admin/services/${addon.id}/catalog`, "PUT", {
        kind: "addon",
        version: 1,
        allowedServiceIds: [f.colorId],
      })
    ).status,
  ).toBe(200);
  await runWaitlist(t.db, { now: NOW });
  const list = (await (await call("/me/waitlist", "GET", undefined, client)).json()) as {
    entries: { id: string; state: string }[];
  };
  expect(list.entries.find((e) => e.id === entry.id)?.state).toBe("unavailable");
  expect((await book([f.haircutId])).status).toBe(201);
});
