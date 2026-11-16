import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { appointmentSeriesPreviewSchema, appointmentSeriesSchema } from "@sob/contracts";
import { appointment, clientProfile, reminder, service } from "@sob/db";
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
let buyer: Actor;
let other: Actor;
const call = (who: Actor | null, path: string, body?: unknown) =>
  json(t.app, path, body ? "POST" : "GET", body, who?.cookie);
const input = () => ({
  staffId: f.anaId,
  clientId: buyer.clientId,
  serviceIds: [f.haircutId],
  startsAt: "2026-03-09T12:00:00.000Z",
  cadence: "weekly",
  interval: 1,
  count: 3,
});
async function review(body = input()) {
  const r = await call(owner, "/appointments/series/preview", body);
  expect(r.status, await r.clone().text()).toBe(200);
  return (await r.json()) as {
    reviewHash: string;
    timezone: string;
    occurrences: { startsAt: string; endsAt: string; available: boolean }[];
  };
}
beforeAll(async () => {
  t = await setupApiTest({ dbSuffix: "appointment_series" });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  f = await seedFixtures(t.db);
  [owner, buyer, other] = await Promise.all([
    actor(t, "owner", "series-owner@test.local"),
    actor(t, "client", "series-buyer@test.local"),
    actor(t, "client", "series-other@test.local"),
  ]);
});
test("recurrence previews concrete salon-local dates and creates the reviewed visits once", async () => {
  const body = input();
  const preview = await review(body);
  expect(preview.occurrences.map((o) => o.startsAt)).toEqual([
    "2026-03-09T12:00:00.000Z",
    "2026-03-16T12:00:00.000Z",
    "2026-03-23T12:00:00.000Z",
  ]);
  expect(preview.occurrences.every((o) => o.available)).toBe(true);
  const request = { ...body, reviewHash: preview.reviewHash, idempotencyKey: crypto.randomUUID() };
  const r = await call(owner, "/appointments/series", request);
  expect(r.status, await r.clone().text()).toBe(201);
  const result = appointmentSeriesSchema.parse(await r.json());
  expect(result.appointments).toHaveLength(3);
  expect(new Set(result.appointments.map((a: { clientId: string }) => a.clientId))).toEqual(
    new Set([buyer.clientId ?? ""]),
  );
  expect((await call(owner, "/appointments/series", request)).status).toBe(201);
  expect(await t.db.select().from(appointment)).toHaveLength(3);
  const list = await call(buyer, `/appointments/series/${result.id}`);
  expect(list.status).toBe(200);
  expect(appointmentSeriesSchema.parse(await list.json()).appointments).toHaveLength(3);
  expect((await call(other, `/appointments/series/${result.id}`)).status).toBe(403);
  expect((await call(owner, "/appointments/series", { ...request, count: 4 })).status).toBe(409);
});
test("one newly occupied occurrence rolls back the entire series and its notifications", async () => {
  const body = input();
  const preview = await review(body);
  expect(
    (
      await call(owner, "/appointments", {
        staffId: f.anaId,
        clientId: other.clientId,
        serviceIds: [f.haircutId],
        startsAt: preview.occurrences[1]?.startsAt,
      })
    ).status,
  ).toBe(201);
  const r = await call(owner, "/appointments/series", {
    ...body,
    reviewHash: preview.reviewHash,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(r.status).toBe(409);
  expect(await t.db.select().from(appointment)).toHaveLength(1);
});
test("a changed service price requires reviewing the series again", async () => {
  const body = input();
  const preview = await review(body);
  await t.db.update(service).set({ priceCents: 123456 }).where(eq(service.id, f.haircutId));
  const r = await call(owner, "/appointments/series", {
    ...body,
    reviewHash: preview.reviewHash,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(r.status).toBe(409);
  expect(await t.db.select().from(appointment)).toHaveLength(0);
});
test("customer recurrence is pinned to its own profile and cannot bypass notice rules", async () => {
  const body = input();
  expect(
    (await call(buyer, "/appointments/series/preview", { ...body, clientId: other.clientId }))
      .status,
  ).toBe(403);
  expect(
    (await call(buyer, "/appointments/series/preview", { ...body, override: true })).status,
  ).toBe(403);
  const previewResponse = await call(buyer, "/appointments/series/preview", {
    ...body,
    clientId: undefined,
  });
  expect(previewResponse.status).toBe(200);
  const preview = appointmentSeriesPreviewSchema.parse(await previewResponse.json());
  const response = await call(buyer, "/appointments/series", {
    ...body,
    clientId: undefined,
    reviewHash: preview.reviewHash,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  expect(
    appointmentSeriesSchema
      .parse(await response.json())
      .appointments.every((a: { clientId: string }) => a.clientId === buyer.clientId),
  ).toBe(true);
});

test("concurrent retries create one series and an uncontactable inline customer is resolved only once", async () => {
  const body = { ...input(), clientId: undefined, client: { name: "New recurring customer" } };
  const previewResponse = await call(owner, "/appointments/series/preview", body);
  expect(previewResponse.status).toBe(200);
  const preview = appointmentSeriesPreviewSchema.parse(await previewResponse.json());
  const request = { ...body, reviewHash: preview.reviewHash, idempotencyKey: crypto.randomUUID() };
  const responses = await Promise.all([
    call(owner, "/appointments/series", request),
    call(owner, "/appointments/series", request),
  ]);
  expect(responses.map((r) => r.status)).toEqual([201, 201]);
  const results = await Promise.all(
    responses.map(async (r) => appointmentSeriesSchema.parse(await r.json())),
  );
  expect(results[0]?.id).toBe(results[1]?.id);
  expect(await t.db.select().from(appointment)).toHaveLength(3);
  const profiles = await t.db
    .select()
    .from(clientProfile)
    .where(eq(clientProfile.name, "New recurring customer"));
  expect(profiles).toHaveLength(1);
});
test("preview exposes unavailable dates beyond the booking horizon and creation cannot leave a partial series", async () => {
  const body = { ...input(), cadence: "monthly" as const, count: 4 };
  const preview = await review(body);
  expect(preview.occurrences[3]?.available).toBe(false);
  const r = await call(owner, "/appointments/series", {
    ...body,
    reviewHash: preview.reviewHash,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(r.status).toBe(409);
  expect(await t.db.select().from(appointment)).toHaveLength(0);
  expect(await t.db.select().from(reminder)).toHaveLength(0);
});
test("series creation preserves calendar permissions and moved visits are scoped to their current calendar", async () => {
  const ana = await actor(t, "staff", "ana-series@test.local", { staffProfileId: f.anaId });
  const bea = await actor(t, "staff", "bea-series@test.local", { staffProfileId: f.beaId });
  expect(
    (await call(ana, "/appointments/series/preview", { ...input(), staffId: f.beaId })).status,
  ).toBe(403);
  const body = input();
  const preview = await review(body);
  const response = await call(owner, "/appointments/series", {
    ...body,
    reviewHash: preview.reviewHash,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(response.status).toBe(201);
  const result = appointmentSeriesSchema.parse(await response.json());
  const visit = result.appointments[1];
  if (!visit) throw new Error("Missing series visit");
  await t.db.update(appointment).set({ staffId: f.beaId }).where(eq(appointment.id, visit.id));
  const own = appointmentSeriesSchema.parse(
    await (await call(ana, `/appointments/series/${result.id}`)).json(),
  );
  const moved = appointmentSeriesSchema.parse(
    await (await call(bea, `/appointments/series/${result.id}`)).json(),
  );
  expect(own.appointments).toHaveLength(2);
  expect(moved.appointments).toHaveLength(1);
  expect(
    appointmentSeriesSchema.parse(
      await (await call(owner, `/appointments/series/${result.id}`)).json(),
    ).appointments,
  ).toHaveLength(3);
  const listing = await json(
    t.app,
    "/appointments?from=2026-03-01T00:00:00Z&to=2026-04-01T00:00:00Z",
    "GET",
    undefined,
    buyer.cookie,
  );
  const items = (await listing.json()) as {
    appointments: { series?: { id: string; position: number; count: number } }[];
  };
  expect(items.appointments.map((a) => a.series?.position)).toEqual([0, 1, 2]);
  expect(items.appointments.every((a) => a.series?.id === result.id && a.series.count === 3)).toBe(
    true,
  );
});

test("series reads omit deleted visits while keeping the original positions of the remaining visits", async () => {
  const body = input();
  const preview = await review(body);
  const r = await call(owner, "/appointments/series", {
    ...body,
    reviewHash: preview.reviewHash,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(r.status).toBe(201);
  const result = appointmentSeriesSchema.parse(await r.json());
  const first = result.appointments[0];
  if (!first) throw new Error("Missing first series visit");
  await t.db.update(appointment).set({ deletedAt: new Date() }).where(eq(appointment.id, first.id));
  const visible = appointmentSeriesSchema.parse(
    await (await call(buyer, `/appointments/series/${result.id}`)).json(),
  );
  expect(visible.appointments).toHaveLength(2);
  expect(visible.appointments.map((a) => a.series?.position)).toEqual([1, 2]);
});
