import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { appointment, checkout, checkoutReward, passPeriod, service } from "@sob/db";
import { eq } from "drizzle-orm";
import {
  type Actor,
  actor,
  type Fixtures,
  json,
  MONDAY_0900,
  NOW,
  seedFixtures,
  setupApiTest,
} from "../../../test/helpers";

let t: Awaited<ReturnType<typeof setupApiTest>>;
let f: Fixtures;
let owner: Actor;
let client: Actor;
let other: Actor;
let selection: {
  staffId: string;
  serviceIds: string[];
  serviceQuotes: Record<string, string>;
  startsAt: string;
  code: string;
};
const call = (who: Actor | null, path: string, method = "GET", input?: unknown) =>
  json(t.app, path, method, input, who?.cookie);
beforeAll(async () => {
  t = await setupApiTest({ dbSuffix: "booking_promotions" });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  f = await seedFixtures(t.db);
  await t.db.update(service).set({ currency: "EUR" });
  [owner, client, other] = await Promise.all([
    actor(t, "owner", "owner@booking-promo.test"),
    actor(t, "client", "client@booking-promo.test"),
    actor(t, "client", "other@booking-promo.test"),
  ]);
  const catalog = (await (await call(client, "/services")).json()) as {
    services: { id: string; quoteHash: string }[];
  };
  const haircut = catalog.services.find((s) => s.id === f.haircutId);
  if (!haircut) throw new Error("Missing service");
  selection = {
    staffId: f.anaId,
    serviceIds: [f.haircutId],
    serviceQuotes: { [f.haircutId]: haircut.quoteHash },
    startsAt: MONDAY_0900,
    code: "BOOKING10",
  };
});
const terms = {
  code: "BOOKING10",
  name: "Fixture booking offer",
  kind: "percent",
  value: 1000,
  eligibleKinds: ["service"],
  perClientLimit: null,
};
async function offer(extra = {}) {
  const r = await call(owner, "/admin/rewards/promotions", "POST", { ...terms, ...extra });
  expect(r.status, await r.clone().text()).toBe(201);
  return (await r.json()) as { id: string; version: number };
}
async function quote(who = client, extra = {}) {
  const r = await call(who, "/appointments/promotion-quote", "POST", { ...selection, ...extra });
  expect(r.status, await r.clone().text()).toBe(200);
  return (await r.json()) as {
    reviewHash: string;
    currentTotalCents: number;
    newTotalCents: number;
    discountCents: number;
    promotionVersion: number;
  };
}
function request(reviewHash: string, extra = {}) {
  const { code, ...fields } = selection;
  return { ...fields, id: crypto.randomUUID(), promotion: { code, reviewHash }, ...extra };
}
test("the booking review quotes its own current offer and creates one server-priced discounted receipt atomically", async () => {
  await offer();
  const q = await quote();
  expect(q).toMatchObject({ currentTotalCents: 10000, newTotalCents: 9000, discountCents: 1000 });
  const input = request(q.reviewHash);
  const r = await call(client, "/appointments", "POST", input);
  expect(r.status, await r.clone().text()).toBe(201);
  expect(await r.json()).toMatchObject({
    bookingPrice: { subtotalCents: 10000, discountCents: 1000, totalCents: 9000, currency: "EUR" },
  });
  const listing = await call(
    client,
    "/appointments?from=2026-03-09T00:00:00Z&to=2026-03-10T00:00:00Z",
  );
  expect(await listing.json()).toMatchObject({
    appointments: [{ bookingPrice: { totalCents: 9000 } }],
  });
  const rows = await t.db.select().from(checkout);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    appointmentId: input.id,
    clientId: client.clientId,
    totalCents: 9000,
    discountCents: 1000,
  });
  expect(await t.db.select().from(checkoutReward)).toHaveLength(1);
  expect((await call(client, "/appointments", "POST", input)).status).toBe(201);
  expect(await t.db.select().from(appointment)).toHaveLength(1);
});
test("appointment reports preserve the offer used at booking and count the visit by current status", async () => {
  const promotion = await offer();
  const input = request((await quote()).reviewHash);
  expect((await call(client, "/appointments", "POST", input)).status).toBe(201);

  const renamed = await call(owner, `/admin/rewards/promotions/${promotion.id}`, "PUT", {
    ...terms,
    name: "Renamed offer",
    code: "NEW10",
    version: promotion.version,
  });
  expect(renamed.status).toBe(200);

  const report = async (query: string) => {
    const response = await call(owner, `/admin/reports/summary?${query}`);
    expect(response.status).toBe(200);
    return response.json();
  };
  const range = "from=2026-03-09&to=2026-03-09";
  const row = { label: "Fixture booking offer (BOOKING10)", appointments: 1 };
  expect(await report(range)).toMatchObject({
    promotionBreakdown: [{ ...row, byStatus: { booked: 1 } }],
  });
  expect(await report(`${range}&staffId=${f.beaId}`)).toMatchObject({ promotionBreakdown: [] });
  expect(await report(`${range}&currency=USD`)).toMatchObject({ promotionBreakdown: [] });
  expect(await report("from=2026-03-10&to=2026-03-10")).toMatchObject({ promotionBreakdown: [] });

  const cancellation = await call(client, `/appointments/${input.id}`, "PATCH", {
    version: 1,
    status: "cancelled",
  });
  expect(cancellation.status).toBe(200);
  expect((await t.db.select().from(checkoutReward))[0]?.state).toBe("released");
  expect(await report(range)).toMatchObject({
    promotionBreakdown: [{ ...row, byStatus: { booked: 0, cancelled: 1 } }],
  });
});

test("a promotion applied at checkout cannot appear as an offer accepted at booking", async () => {
  const { version } = await offer();
  const id = crypto.randomUUID();
  const { code, ...booking } = selection;
  expect((await call(client, "/appointments", "POST", { ...booking, id })).status).toBe(201);
  const idempotencyKey = `booking-promotion-${id}`;
  const sale = await call(client, "/me/checkouts", "POST", {
    appointmentId: id,
    currency: "EUR",
    lines: [],
    idempotencyKey,
  });
  expect(sale.status, await sale.clone().text()).toBe(201);
  const { id: saleId } = await sale.json();
  const applied = await call(client, `/me/checkouts/${saleId}/reward`, "POST", {
    kind: "promotion",
    code,
    expectedTotalCents: 10000,
    expectedDiscountCents: 1000,
    expectedPromotionVersion: version,
    idempotencyKey,
  });
  expect(applied.status, await applied.clone().text()).toBe(200);
  const report = await call(owner, "/admin/reports/summary?from=2026-03-09&to=2026-03-09");
  expect(await report.json()).toMatchObject({ promotionBreakdown: [] });
});
test("changing offer terms invalidates the booking review without leaving a visit or consuming quota", async () => {
  const p = await offer();
  const q = await quote();
  const input = request(q.reviewHash);
  expect(
    (
      await call(owner, `/admin/rewards/promotions/${p.id}`, "PUT", {
        ...terms,
        name: "Changed review",
        version: p.version,
      })
    ).status,
  ).toBe(200);
  expect((await call(client, "/appointments", "POST", input)).status).toBe(409);
  expect(await t.db.select().from(appointment)).toHaveLength(0);
  expect(await t.db.select().from(checkoutReward)).toHaveLength(0);
  const current = await quote();
  expect(
    (
      await call(client, "/appointments", "POST", {
        ...input,
        promotion: { code: selection.code, reviewHash: current.reviewHash },
      })
    ).status,
  ).toBe(201);
});
test("a protected booking calculates its deposit from the explicitly reviewed discounted total", async () => {
  await offer({ value: 2000 });
  const policy = await call(owner, "/admin/settings/booking-policy", "PUT", {
    enabled: true,
    depositKind: "percent",
    depositValue: 2500,
    holdMinutes: 15,
    cancellationWindowMinutes: 1440,
    lateCancellationBasisPoints: 2500,
    noShowBasisPoints: 5000,
    trustedExempt: true,
    version: 1,
  });
  expect(policy.status).toBe(200);
  const saved = (await policy.json()) as { version: number };
  const q = await quote();
  expect(q.newTotalCents).toBe(8000);
  const r = await call(
    client,
    "/appointments",
    "POST",
    request(q.reviewHash, {
      protectionAcceptedVersion: saved.version,
      protectionAcceptedTotalCents: q.newTotalCents,
    }),
  );
  expect(r.status, await r.clone().text()).toBe(201);
  expect(await r.json()).toMatchObject({ protection: { depositCents: 2000, state: "pending" } });
  expect((await t.db.select().from(checkout))[0]).toMatchObject({
    totalCents: 8000,
    discountCents: 2000,
  });
});
test("two reviewed bookings cannot both reserve the final use of a code", async () => {
  await offer({ usageLimit: 1 });
  const [a, b] = await Promise.all([
    quote(client),
    quote(other, { startsAt: "2026-03-09T13:00:00Z" }),
  ]);
  const responses = await Promise.all([
    call(client, "/appointments", "POST", request(a.reviewHash)),
    call(
      other,
      "/appointments",
      "POST",
      request(b.reviewHash, { startsAt: "2026-03-09T13:00:00Z" }),
    ),
  ]);
  expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
  expect(responses.filter((r) => r.status === 409)).toHaveLength(1);
  expect(await t.db.select().from(checkoutReward)).toHaveLength(1);
});
test("timed booking offers use the authoritative creation clock and freeze their accepted conditions", async () => {
  await offer({
    timing: { weekdays: [1], startMinute: 540, endMinute: 600, lastMinuteHours: 168 },
  });
  const q = await quote();
  const r = await call(client, "/appointments", "POST", request(q.reviewHash));
  expect(r.status, await r.clone().text()).toBe(201);
  expect((await t.db.select().from(checkoutReward))[0]?.appointmentTiming).toMatchObject({
    timing: { lastMinuteHours: 168 },
    timeZone: "America/Argentina/Buenos_Aires",
  });
});
test("a booking quote is authenticated, cannot name another client and is not a cross-account transferable review", async () => {
  await offer();
  expect((await call(null, "/appointments/promotion-quote", "POST", selection)).status).toBe(401);
  expect(
    (
      await call(client, "/appointments/promotion-quote", "POST", {
        ...selection,
        clientId: other.clientId,
      })
    ).status,
  ).toBe(400);
  const q = await quote();
  expect((await call(other, "/appointments", "POST", request(q.reviewHash))).status).toBe(409);
  expect(await t.db.select().from(appointment)).toHaveLength(0);
});
test("an uncertain original booking recovers its original discount after the source is archived", async () => {
  const p = await offer();
  const q = await quote();
  const input = request(q.reviewHash);
  expect((await call(client, "/appointments", "POST", input)).status).toBe(201);
  expect(
    (
      await call(owner, `/admin/rewards/promotions/${p.id}`, "PUT", {
        ...terms,
        active: false,
        value: 2000,
        version: p.version,
      })
    ).status,
  ).toBe(200);
  const recovered = await call(client, "/appointments", "POST", input);
  expect(recovered.status).toBe(201);
  expect(recovered.headers.get("x-idempotent-replay")).toBe("true");
  expect((await t.db.select().from(checkout))[0]?.totalCents).toBe(9000);
  expect(await t.db.select().from(appointment)).toHaveLength(1);
  const changed = await call(client, "/appointments", "POST", {
    ...input,
    promotion: { ...input.promotion, reviewHash: "0".repeat(64) },
  });
  expect(changed.status).toBe(409);
  expect(await changed.json()).toMatchObject({ error: { code: "booking_intent_conflict" } });
});
test("a fully discounted protected visit has no fictitious payment, deposit or premature fulfillment", async () => {
  await offer({ value: 10000 });
  const policy = await call(owner, "/admin/settings/booking-policy", "PUT", {
    enabled: true,
    depositKind: "percent",
    depositValue: 2500,
    holdMinutes: 15,
    cancellationWindowMinutes: 1440,
    lateCancellationBasisPoints: 2500,
    noShowBasisPoints: 5000,
    trustedExempt: true,
    version: 1,
  });
  expect(policy.status).toBe(200);
  const saved = (await policy.json()) as { version: number };
  const q = await quote();
  expect(q.newTotalCents).toBe(0);
  const input = request(q.reviewHash, {
    protectionAcceptedVersion: saved.version,
    protectionAcceptedTotalCents: 0,
  });
  const r = await call(client, "/appointments", "POST", input);
  expect(r.status, await r.clone().text()).toBe(201);
  expect(await r.json()).toMatchObject({ protection: { state: "waived", depositCents: 0 } });
  const rows = await t.db.select().from(checkout);
  const receipt = await call(client, `/me/checkouts/${rows[0]?.id}`);
  expect(await receipt.json()).toMatchObject({
    totalCents: 0,
    paidCents: 0,
    payableCents: 0,
    fulfilledAt: null,
    payments: [],
  });
});

test("booking promotions retain the better membership discount without stacking both percentages", async () => {
  const created = await call(owner, "/admin/benefit-plans", "POST", {
    name: "Fixture member benefit",
    kind: "membership",
    priceCents: 1000,
    includedUses: 0,
    periodMonths: 1,
    discountBasisPoints: 1000,
    serviceIds: [f.haircutId],
    idempotencyKey: crypto.randomUUID(),
  });
  expect(created.status).toBe(201);
  const plan = (await created.json()) as { id: string };
  const purchased = await call(owner, "/admin/passes", "POST", {
    planId: plan.id,
    clientId: client.clientId,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(purchased.status).toBe(201);
  const purchase = (await purchased.json()) as { pass: { id: string }; checkout: { id: string } };
  expect(
    (
      await call(owner, `/admin/commerce/checkouts/${purchase.checkout.id}/payments`, "POST", {
        method: "external_card",
        amountCents: 1000,
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(201);
  await t.db
    .update(passPeriod)
    .set({ startsAt: NOW, endsAt: new Date("2026-04-02T12:00:00Z") })
    .where(eq(passPeriod.contractId, purchase.pass.id));
  await offer({ value: 2000 });
  const q = await quote();
  expect(q).toMatchObject({ currentTotalCents: 9000, newTotalCents: 8000, discountCents: 1000 });
  const input = request(q.reviewHash);
  expect((await call(client, "/appointments", "POST", input)).status).toBe(201);
  const [receipt] = await t.db.select().from(checkout).where(eq(checkout.appointmentId, input.id));
  expect(receipt).toMatchObject({ subtotalCents: 10000, discountCents: 2000, totalCents: 8000 });
});
test("a free online booking without deposits waits for completion and releases its code on cancellation", async () => {
  await offer({ value: 10000 });
  const q = await quote();
  const input = request(q.reviewHash);
  const response = await call(client, "/appointments", "POST", input);
  expect(response.status).toBe(201);
  const [row] = await t.db.select().from(checkout);
  if (!row) throw new Error("Missing booking receipt");
  expect(row.fulfilledAt).toBeNull();
  expect((await t.db.select().from(checkoutReward))[0]?.state).toBe("held");
  expect(
    (await call(client, `/appointments/${input.id}`, "PATCH", { version: 1, status: "cancelled" }))
      .status,
  ).toBe(200);
  const receipt = await call(client, `/me/checkouts/${row.id}`);
  expect(await receipt.json()).toMatchObject({
    status: "void",
    paidCents: 0,
    payments: [],
    reward: { state: "released" },
  });
});
test("an advance-paid promotional visit can be cancelled and refunded without recognizing unperformed service", async () => {
  await offer();
  const q = await quote();
  const input = request(q.reviewHash);
  expect((await call(client, "/appointments", "POST", input)).status).toBe(201);
  const [sale] = await t.db.select().from(checkout);
  if (!sale) throw new Error("Missing receipt");
  const paid = await call(owner, `/admin/commerce/checkouts/${sale.id}/payments`, "POST", {
    method: "external_card",
    amountCents: 9000,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(paid.status, await paid.clone().text()).toBe(201);
  const payment = (await paid.json()) as { payment: { id: string } };
  expect((await t.db.select().from(checkout))[0]?.fulfilledAt).toBeNull();
  expect(
    (await call(client, `/appointments/${input.id}`, "PATCH", { version: 1, status: "cancelled" }))
      .status,
  ).toBe(200);
  const returned = await call(
    owner,
    `/admin/commerce/payments/${payment.payment.id}/refunds`,
    "POST",
    {
      amountCents: 9000,
      reason: "Cancelled advance-paid fixture visit",
      idempotencyKey: crypto.randomUUID(),
    },
  );
  expect(returned.status, await returned.clone().text()).toBe(201);
  const receipt = await call(client, `/me/checkouts/${sale.id}`);
  expect(await receipt.json()).toMatchObject({
    paidCents: 9000,
    refundedCents: 9000,
    fulfilledAt: null,
    reward: { state: "released" },
  });
});
