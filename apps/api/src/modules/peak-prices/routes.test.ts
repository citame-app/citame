import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import {
  appointmentSchema,
  appointmentSeriesPreviewSchema,
  appointmentSeriesSchema,
  checkoutSchema,
  peakPricePolicySchema,
  peakPriceQuoteSchema,
} from "@sob/contracts";
import { appointment, service } from "@sob/db";
import { eq } from "drizzle-orm";
import {
  type Actor,
  actor,
  type Fixtures,
  json,
  seedFixtures,
  setupApiTest,
} from "../../../test/helpers";

import { pricePeakSlot } from "./service";

let t: Awaited<ReturnType<typeof setupApiTest>>;
let f: Fixtures;
let owner: Actor;
let customer: Actor;
const startsAt = "2026-03-09T12:00:00.000Z";
const ordinary = "2026-03-09T13:00:00.000Z";
const call = (path: string, method = "GET", data?: unknown, who = owner) =>
  json(t.app, path, method, data, who.cookie);

beforeAll(async () => {
  t = await setupApiTest({ dbSuffix: "peak_prices" });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  f = await seedFixtures(t.db);
  await t.db.update(service).set({ currency: "EUR" }).where(eq(service.id, f.haircutId));
  [owner, customer] = await Promise.all([
    actor(t, "owner", "peak-owner@example.com"),
    actor(t, "client", "peak-customer@example.com"),
  ]);
});

const rule = (increaseBasisPoints: number) => ({
  weekday: 1,
  startMinute: 540,
  endMinute: 600,
  increaseBasisPoints,
  serviceIds: [f.haircutId],
});
async function policy() {
  return peakPricePolicySchema.parse(await (await call("/admin/peak-prices")).json());
}
async function preview(at = startsAt) {
  const query = new URLSearchParams({ startsAt: at, serviceIds: f.haircutId });
  const response = await t.app.request(`/availability/peak-price?${query}`);
  expect(response.status, await response.clone().text()).toBe(200);
  return peakPriceQuoteSchema.parse(await response.json());
}
function book(id: string, peakPriceReview?: string, at = startsAt) {
  return call("/appointments", "POST", {
    id,
    staffId: f.anaId,
    clientId: f.clientId,
    serviceIds: [f.haircutId],
    startsAt: at,
    ...(peakPriceReview ? { peakPriceReview } : {}),
  });
}

test("a treatment's reviewed local-time surcharge is frozen through booking and checkout", async () => {
  const empty = await policy();
  expect(empty.rules).toEqual([]);
  const schedule = { ...empty, rules: [rule(2500), { ...rule(1000), serviceIds: [] }] };
  expect((await call("/admin/peak-prices", "PUT", schedule, customer)).status).toBe(403);
  expect((await call("/admin/peak-prices", "PUT", { ...schedule, generation: "old" })).status).toBe(
    409,
  );
  expect((await call("/admin/peak-prices", "PUT", schedule)).status).toBe(200);
  expect(
    peakPricePolicySchema.parse(await (await call("/admin/peak-prices", "PUT", schedule)).json())
      .version,
  ).toBe(1);

  const eligible = await preview();
  expect(eligible.services).toMatchObject([
    { baseCents: 10000, surchargeCents: 2500, priceCents: 12500 },
  ]);
  expect(eligible.review).toMatch(/^[a-f0-9]{64}$/);
  expect(await preview(ordinary)).toMatchObject({
    review: null,
    services: [{ priceCents: 10000 }],
  });
  const id = crypto.randomUUID();
  const omitted = await book(id);
  expect(omitted.status).toBe(409);
  expect(await t.db.select().from(appointment)).toHaveLength(0);
  const recorded = await book(id, eligible.review ?? undefined);
  expect(recorded.status, await recorded.clone().text()).toBe(201);
  const booking = appointmentSchema.parse(await recorded.json());
  expect(booking.services).toMatchObject([{ priceCents: 12500, peakSurchargeCents: 2500 }]);

  const latest = await policy();
  expect((await call("/admin/peak-prices", "PUT", { ...latest, rules: [rule(4000)] })).status).toBe(
    200,
  );
  expect(await preview()).toMatchObject({ services: [{ priceCents: 14000 }] });
  const replay = await book(id, eligible.review ?? undefined);
  expect(replay.status).toBe(201);
  expect(replay.headers.get("x-idempotent-replay")).toBe("true");
  expect((await book(id, (await preview()).review ?? undefined)).status).toBe(409);

  const receipt = await call("/admin/commerce/checkouts", "POST", {
    appointmentId: id,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(receipt.status, await receipt.clone().text()).toBe(201);
  expect(checkoutSchema.parse(await receipt.json())).toMatchObject({
    totalCents: 12500,
    lines: [{ unitAmountCents: 12500 }],
  });
});

test("a stale review cannot apply a changed price and public previews hide internal treatments", async () => {
  const state = await policy();
  expect((await call("/admin/peak-prices", "PUT", { ...state, rules: [rule(1500)] })).status).toBe(
    200,
  );
  const before = await preview();
  const revision = await policy();
  expect(
    (await call("/admin/peak-prices", "PUT", { ...revision, rules: [rule(2200)] })).status,
  ).toBe(200);
  const stale = await book(crypto.randomUUID(), before.review ?? undefined);
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ error: { code: "peak_price_changed" } });
  expect(await t.db.select().from(appointment)).toHaveLength(0);
  await t.db.update(service).set({ onlineBooking: false }).where(eq(service.id, f.haircutId));
  const query = new URLSearchParams({ startsAt, serviceIds: f.haircutId });
  expect((await t.app.request(`/availability/peak-price?${query}`)).status).toBe(404);
  expect((await call(`/appointments/peak-price?${query}`)).status).toBe(200);
});

test("series preview binds the price of each occurrence and cannot charge an unreviewed surcharge", async () => {
  const state = await policy();
  expect((await call("/admin/peak-prices", "PUT", { ...state, rules: [rule(1400)] })).status).toBe(
    200,
  );
  const input = {
    clientId: f.clientId,
    staffId: f.anaId,
    serviceIds: [f.haircutId],
    startsAt,
    cadence: "weekly",
    interval: 1,
    count: 2,
  };
  const response = await call("/appointments/series/preview", "POST", input);
  expect(response.status, await response.clone().text()).toBe(200);
  const reviewed = appointmentSeriesPreviewSchema.parse(await response.json());
  expect(reviewed.occurrences).toMatchObject([
    { priceCents: 11400, peakSurchargeCents: 1400, available: true },
    { priceCents: 11400, peakSurchargeCents: 1400, available: true },
  ]);
  const body = { ...input, reviewHash: reviewed.reviewHash, idempotencyKey: crypto.randomUUID() };
  const omitted = await call("/appointments/series", "POST", body);
  expect(omitted.status).toBe(409);
  expect(await omitted.json()).toMatchObject({ error: { code: "peak_price_changed" } });
  expect(await t.db.select().from(appointment)).toHaveLength(0);

  const confirmed = await call("/appointments/series", "POST", {
    ...body,
    peakPriceReviews: reviewed.occurrences.map((slot) => slot.peakPriceReview ?? null),
  });
  expect(confirmed.status, await confirmed.clone().text()).toBe(201);
  const series = appointmentSeriesSchema.parse(await confirmed.json());
  expect(series.appointments.map((item) => item.services[0])).toMatchObject([
    { priceCents: 11400, peakSurchargeCents: 1400 },
    { priceCents: 11400, peakSurchargeCents: 1400 },
  ]);
});

test("two treatments use their individual starts, including the first treatment's cleanup", () => {
  const services = ["first", "second"].map((id) => ({
    id,
    name: id,
    description: null,
    currency: "EUR",
    durationMinutes: 30,
    bufferMinutes: 10,
    priceCents: 10000,
  }));
  const quote = pricePeakSlot(
    {
      version: 1,
      rules: [
        { weekday: 1, startMinute: 580, endMinute: 600, increaseBasisPoints: 1000, serviceIds: [] },
      ],
    },
    services,
    new Date(startsAt),
    "America/Argentina/Buenos_Aires",
  );
  expect(quote.services.map((line) => line.surchargeCents)).toEqual([0, 1000]);
});
