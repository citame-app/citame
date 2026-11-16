import { afterAll, expect, test } from "bun:test";
import { appointment } from "@sob/db";
import { actor, json, seedFixtures, setupApiTest } from "../../../test/helpers";

let close: (() => Promise<void>) | undefined;
afterAll(async () => {
  await close?.();
});
test("a recurring preview reports resource conflicts on other professionals and an unavailable series creates no partial visits", async () => {
  const t = await setupApiTest({ dbSuffix: "series_capacity" });
  close = t.close;
  await t.reset();
  const f = await seedFixtures(t.db);
  const owner = await actor(t, "owner", "owner@series-capacity.test");
  const call = (path: string, body: unknown, method = "POST") =>
    json(t.app, path, method, body, owner.cookie);
  const resource = await call("/admin/resources", {
    name: "Treatment room",
    kind: "room",
    capacity: 1,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(resource.status).toBe(201);
  const pool = (await resource.json()) as { id: string };
  expect(
    (
      await call(
        `/admin/services/${f.haircutId}/resources`,
        { version: 1, requirements: [{ resourceId: pool.id, quantity: 1 }] },
        "PUT",
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await call("/appointments", {
        staffId: f.beaId,
        clientId: f.clientId,
        serviceIds: [f.haircutId],
        startsAt: "2026-03-16T12:00:00.000Z",
      })
    ).status,
  ).toBe(201);
  const input = {
    staffId: f.anaId,
    clientId: f.clientId,
    serviceIds: [f.haircutId],
    startsAt: "2026-03-09T12:00:00.000Z",
    cadence: "weekly",
    interval: 1,
    count: 2,
  };
  const r = await call("/appointments/series/preview", input);
  expect(r.status).toBe(200);
  const preview = (await r.json()) as { reviewHash: string; occurrences: { available: boolean }[] };
  expect(preview.occurrences.map((o) => o.available)).toEqual([true, false]);
  expect(
    (
      await call("/appointments/series", {
        ...input,
        reviewHash: preview.reviewHash,
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(409);
  expect(await t.db.select().from(appointment)).toHaveLength(1);
});
