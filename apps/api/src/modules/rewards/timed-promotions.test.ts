import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { appointment, appointmentService } from "@sob/db";
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
const call = (path: string, method = "GET", input?: unknown) =>
  json(t.app, path, method, input, owner.cookie);
const timing = { weekdays: [1, 2, 3, 4, 5], startMinute: 540, endMinute: 600, lastMinuteHours: 24 };
const offer = {
  code: "LASTMORNING",
  name: "Fixture morning",
  kind: "percent",
  value: 1000,
  eligibleKinds: ["service"],
  perClientLimit: null,
  timing,
};
beforeAll(async () => {
  t = await setupApiTest({ dbSuffix: "timed_promotions" });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  f = await seedFixtures(t.db);
  owner = await actor(t, "owner", "owner@timed-promotions.test");
});
async function createOffer() {
  const r = await call("/admin/rewards/promotions", "POST", offer);
  expect(r.status, await r.clone().text()).toBe(201);
  return (await r.json()) as { id: string; version: number };
}
async function visit(createdAt = "2026-03-08T12:00:00Z", startsAt = "2026-03-09T12:00:00Z") {
  const [a] = await t.db
    .insert(appointment)
    .values({
      staffId: f.anaId,
      clientId: f.clientId,
      startsAt: new Date(startsAt),
      endsAt: new Date(Date.parse(startsAt) + 3600000),
      createdAt: new Date(createdAt),
    })
    .returning();
  if (!a) throw new Error("Missing visit");
  await t.db.insert(appointmentService).values({
    appointmentId: a.id,
    serviceId: f.haircutId,
    position: 0,
    name: "Fixture cut",
    durationMinutes: 45,
    bufferMinutes: 15,
    priceCents: 10000,
    currency: "EUR",
  });
  const r = await call("/admin/commerce/checkouts", "POST", {
    appointmentId: a.id,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(r.status, await r.clone().text()).toBe(201);
  return { a, bill: (await r.json()) as { id: string; totalCents: number } };
}
const quote = (id: string) =>
  call(`/admin/commerce/checkouts/${id}/reward/quote`, "POST", {
    kind: "promotion",
    code: offer.code,
  });
async function apply(id: string) {
  const q = await quote(id);
  expect(q.status, await q.clone().text()).toBe(200);
  const prices = (await q.json()) as {
    currentTotalCents: number;
    discountCents: number;
    promotionVersion: number;
  };
  const r = await call(`/admin/commerce/checkouts/${id}/reward`, "POST", {
    kind: "promotion",
    code: offer.code,
    expectedTotalCents: prices.currentTotalCents,
    expectedDiscountCents: prices.discountCents,
    expectedPromotionVersion: prices.promotionVersion,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(r.status, await r.clone().text()).toBe(200);
}
test("a timed offer qualifies the reviewed local appointment start and original booking lead", async () => {
  await createOffer();
  const { bill } = await visit();
  expect((await quote(bill.id)).status).toBe(200);
});
test("waiting until checkout cannot turn an advance booking into a last-minute booking", async () => {
  await createOffer();
  const { bill } = await visit("2026-03-02T12:00:00Z");
  expect((await quote(bill.id)).status).toBe(409);
});
test("the local window excludes its end even when the same code is otherwise valid", async () => {
  await createOffer();
  const { bill } = await visit("2026-03-08T13:00:00Z", "2026-03-09T13:00:00Z");
  expect((await quote(bill.id)).status).toBe(409);
});
test("rescheduling keeps the original time conditions after the promotion is edited", async () => {
  const p = await createOffer();
  const { a, bill } = await visit();
  await apply(bill.id);
  expect(
    (
      await call(`/admin/rewards/promotions/${p.id}`, "PUT", {
        ...offer,
        timing: undefined,
        version: p.version,
      })
    ).status,
  ).toBe(200);
  const moved = await call(`/appointments/${a.id}`, "PATCH", {
    version: a.version,
    startsAt: "2026-03-09T13:00:00Z",
  });
  expect(moved.status, await moved.clone().text()).toBe(409);
  const original = await call(`/appointments/${a.id}`, "PATCH", {
    version: a.version,
    startsAt: "2026-03-09T12:15:00Z",
  });
  // The original 24-hour lead still applies: moving later cannot extend the booking window.
  expect(original.status).toBe(409);
});
test("changed timed conditions require a fresh quote even when the penny discount is unchanged", async () => {
  const p = await createOffer();
  const { bill } = await visit();
  const q = await quote(bill.id);
  const prices = (await q.json()) as {
    currentTotalCents: number;
    discountCents: number;
    promotionVersion?: number;
  };
  expect(
    (
      await call(`/admin/rewards/promotions/${p.id}`, "PUT", {
        ...offer,
        timing: { ...timing, endMinute: 630 },
        version: p.version,
      })
    ).status,
  ).toBe(200);
  const applied = await call(`/admin/commerce/checkouts/${bill.id}/reward`, "POST", {
    kind: "promotion",
    code: offer.code,
    expectedTotalCents: prices.currentTotalCents,
    expectedDiscountCents: prices.discountCents,
    expectedPromotionVersion: prices.promotionVersion,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(applied.status).toBe(409);
});
test("an allowed move retains saved terms when the current offer is narrowed or deactivated", async () => {
  const p = await createOffer();
  const { a, bill } = await visit("2026-03-08T12:30:00Z");
  await apply(bill.id);
  expect(
    (
      await call(`/admin/rewards/promotions/${p.id}`, "PUT", {
        ...offer,
        active: false,
        timing: { ...timing, weekdays: [2] },
        version: p.version,
      })
    ).status,
  ).toBe(200);
  const moved = await call(`/appointments/${a.id}`, "PATCH", {
    version: a.version,
    startsAt: "2026-03-09T12:15:00Z",
  });
  expect(moved.status, await moved.clone().text()).toBe(200);
  const receipt = await call(`/admin/commerce/checkouts/${bill.id}`);
  expect(await receipt.json()).toMatchObject({
    totalCents: 9000,
    reward: { appointmentTiming: { timing, timeZone: "America/Argentina/Buenos_Aires" } },
  });
});
test("timed offers cannot be applied without reviewing their version", async () => {
  await createOffer();
  const { bill } = await visit();
  const r = await call(`/admin/commerce/checkouts/${bill.id}/reward`, "POST", {
    kind: "promotion",
    code: offer.code,
    expectedTotalCents: 10000,
    expectedDiscountCents: 1000,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(r.status).toBe(409);
});
