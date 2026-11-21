import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { adminLoyaltyStatementSchema } from "@sob/contracts";
import {
  appointment,
  appointmentService,
  checkout,
  checkoutLine,
  checkoutReward,
  loyaltyLot,
  service,
  staffProfile,
} from "@sob/db";
import { eq } from "drizzle-orm";
import {
  type Actor,
  actor,
  type Fixtures,
  json,
  seedFixtures,
  setupApiTest,
} from "../../../test/helpers";

import { pull } from "../../../test/sync";

let t: Awaited<ReturnType<typeof setupApiTest>>;
let f: Fixtures;
let owner: Actor;
let client: Actor;
let other: Actor;
const key = () => crypto.randomUUID();
const call = (who: Actor | null, path: string, method = "GET", body?: unknown) =>
  json(t.app, path, method, body, who?.cookie);
const policy = {
  enabled: true,
  earnEveryCents: 100,
  pointsPerStep: 1,
  redeemValueCents: 10,
  maximumDiscountBasisPoints: 2000,
  expiryDays: 365,
  version: 1,
};
beforeAll(async () => {
  t = await setupApiTest({ dbSuffix: "rewards" });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  f = await seedFixtures(t.db);
  [owner, client, other] = await Promise.all([
    actor(t, "owner", "owner@rewards.test"),
    actor(t, "client", "buyer@rewards.test"),
    actor(t, "client", "other@rewards.test"),
  ]);
});
async function enable() {
  const r = await call(owner, "/admin/rewards/policy", "PUT", policy);
  expect(r.status, await r.clone().text()).toBe(200);
}
async function sale(price = 10000, who = client) {
  const r = await call(owner, "/admin/commerce/checkouts", "POST", {
    clientId: who.clientId,
    staffId: f.anaId,
    lines: [{ kind: "custom", description: "Beauty service", quantity: 1, unitAmountCents: price }],
    idempotencyKey: key(),
  });
  expect(r.status, await r.clone().text()).toBe(201);
  return (await r.json()) as { id: string; totalCents: number };
}
const pay = (id: string, amountCents: number) =>
  call(owner, `/admin/commerce/checkouts/${id}/payments`, "POST", {
    method: "external_card",
    amountCents,
    idempotencyKey: key(),
  });
test("rewards start disabled and a customer cannot change the current program", async () => {
  const r = await call(client, "/me/rewards");
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({
    policy: { enabled: false },
    balancePoints: 0,
    availablePoints: 0,
  });
  expect((await call(client, "/admin/rewards/policy", "PUT", policy)).status).toBe(403);
  await enable();
  expect((await call(owner, "/admin/rewards/policy", "PUT", policy)).status).toBe(409);
});
test("manual credits are owner-controlled, audited, idempotent and private to their customer", async () => {
  await enable();
  const credit = {
    points: 100,
    reason: "Welcome credit approved by the salon",
    idempotencyKey: key(),
  };
  const path = `/admin/rewards/clients/${client.clientId}/adjustments`;
  expect((await call(owner, path, "POST", credit)).status).toBe(201);
  expect((await call(owner, path, "POST", credit)).status).toBe(201);
  expect(await (await call(client, "/me/rewards")).json()).toMatchObject({ availablePoints: 100 });
  expect(await (await call(other, "/me/rewards")).json()).toMatchObject({ availablePoints: 0 });
  expect((await call(client, path, "POST", credit)).status).toBe(403);
  expect((await call(owner, path, "POST", { ...credit, points: 101 })).status).toBe(409);
});
test("point spending is server-priced, capped, serialized and cannot change a receipt after a payment attempt", async () => {
  await enable();
  expect(
    (
      await call(owner, `/admin/rewards/clients/${client.clientId}/adjustments`, "POST", {
        points: 100,
        reason: "Verified loyalty migration credit",
        idempotencyKey: key(),
      })
    ).status,
  ).toBe(201);
  const [a, b] = await Promise.all([sale(), sale()]);
  const apply = (id: string, points = 100) =>
    call(client, `/me/checkouts/${id}/reward`, "POST", {
      kind: "points",
      points,
      expectedTotalCents: 10000,
      expectedDiscountCents: 1000,
      idempotencyKey: key(),
    });
  const spent = await Promise.all([apply(a.id), apply(b.id)]);
  expect(spent.map((r) => r.status).sort()).toEqual([200, 409]);
  const used = spent.findIndex((r) => r.status === 200);
  const result = await spent[used]?.json();
  expect(result).toMatchObject({ totalCents: 9000, discountCents: 1000 });
  expect(await (await call(client, "/me/rewards")).json()).toMatchObject({
    availablePoints: 0,
    reservedPoints: 100,
  });
  expect((await pay(used === 0 ? a.id : b.id, 9000)).status).toBe(201);
  expect((await apply(used === 0 ? a.id : b.id, 1)).status).toBe(409);
});

const balance = async () =>
  (await (await call(client, "/me/rewards")).json()) as {
    availablePoints: number;
    balancePoints: number;
    reservedPoints: number;
  };
async function credit(points = 100) {
  const response = await call(
    owner,
    `/admin/rewards/clients/${client.clientId}/adjustments`,
    "POST",
    { points, reason: "Verified salon loyalty adjustment", idempotencyKey: key() },
  );
  expect(response.status, await response.clone().text()).toBe(201);
}
async function redeem(id: string, points = 100) {
  const response = await call(client, `/me/checkouts/${id}/reward`, "POST", {
    kind: "points",
    points,
    expectedTotalCents: 10000,
    expectedDiscountCents: points * 10,
    idempotencyKey: key(),
  });
  expect(response.status, await response.clone().text()).toBe(200);
}
async function fundedSale(price = 10000) {
  const s = await sale(price);
  const response = await pay(s.id, price);
  expect(response.status).toBe(201);
  return { ...s, paymentId: ((await response.json()) as { payment: { id: string } }).payment.id };
}
const refund = (paymentId: string, amountCents: number, idempotencyKey = key()) =>
  call(owner, `/admin/commerce/payments/${paymentId}/refunds`, "POST", {
    amountCents,
    reason: "Verified original service return",
    idempotencyKey,
  });
test("settled eligible sales earn once at the retained price and partial payments do not earn early", async () => {
  await enable();
  const s = await sale();
  expect((await pay(s.id, 4000)).status).toBe(201);
  expect((await balance()).availablePoints).toBe(0);
  expect((await pay(s.id, 6000)).status).toBe(201);
  expect((await balance()).availablePoints).toBe(100);
  const receipt = (await (await call(client, `/me/checkouts/${s.id}`)).json()) as {
    payments: { id: string }[];
  };
  const idem = key();
  const payment = receipt.payments[0];
  if (!payment) throw new Error("Missing partial payment");
  expect((await refund(payment.id, 2000, idem)).status).toBe(201);
  expect((await refund(payment.id, 2000, idem)).status).toBe(201);
  expect((await balance()).availablePoints).toBe(80);
});
test("spent-point refunds create a points debt and cancelling the unused reward clears it without minting points", async () => {
  await enable();
  const source = await fundedSale();
  const target = await sale();
  await redeem(target.id);
  expect((await refund(source.paymentId, 10000)).status).toBe(201);
  expect(await balance()).toMatchObject({
    availablePoints: 0,
    balancePoints: -100,
    reservedPoints: 100,
  });
  expect(
    (await call(owner, `/admin/commerce/checkouts/${target.id}/void`, "POST", {})).status,
  ).toBe(200);
  expect(await balance()).toMatchObject({
    availablePoints: 0,
    balancePoints: 0,
    reservedPoints: 0,
  });
});
test("returning a rewarded sale restores the original spent points and reverses points earned by that sale", async () => {
  await enable();
  await credit();
  const target = await sale();
  await redeem(target.id);
  const result = await pay(target.id, 9000);
  expect(result.status).toBe(201);
  const paymentId = ((await result.json()) as { payment: { id: string } }).payment.id;
  expect((await balance()).availablePoints).toBe(90);
  expect((await refund(paymentId, 9000)).status).toBe(201);
  expect(await balance()).toMatchObject({ availablePoints: 100, reservedPoints: 0 });
});
test("voiding an unpaid redemption returns points with their original expiry instead of extending it", async () => {
  await enable();
  await credit();
  const target = await sale();
  await redeem(target.id);
  if (!client.clientId) throw new Error("Missing client");
  await t.db
    .update(loyaltyLot)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(loyaltyLot.clientId, client.clientId));
  expect(
    (await call(owner, `/admin/commerce/checkouts/${target.id}/void`, "POST", {})).status,
  ).toBe(200);
  expect(await balance()).toMatchObject({ availablePoints: 0, reservedPoints: 0 });
  const [lot] = await t.db.select().from(loyaltyLot);
  expect(lot).toMatchObject({ remainingPoints: 0, spentPoints: 0, expiredPoints: 100 });
});
test("desktop loyalty statements are private and reviewed point adjustments replay only once", async () => {
  await call(owner, "/admin/rewards/policy", "PUT", { ...policy });
  const path = `/admin/rewards/clients/${f.clientId}`;
  const receptionist = await actor(t, "staff", "loyalty-reception@example.test", {
    staffProfileId: f.anaId,
  });
  await t.db
    .update(staffProfile)
    .set({ accessPreset: "receptionist" })
    .where(eq(staffProfile.id, f.anaId));
  const desk = await call(owner, path);
  expect(desk.headers.get("cache-control")).toBe("private, no-store");
  const statement = adminLoyaltyStatementSchema.parse(await desk.json());
  expect(statement.canAdjust).toBe(true);
  expect(statement.availablePoints).toBe(0);
  const limited = adminLoyaltyStatementSchema.parse(await (await call(receptionist, path)).json());
  expect(limited.canAdjust).toBe(false);
  expect((await call(client, path)).status).toBe(403);

  const packet = { points: 50, reason: "Synthetic desk adjustment", idempotencyKey: key() };
  const save = (generation: string, who = owner, payload = packet) =>
    t.app.request(`${path}/adjustments`, {
      method: "POST",
      headers: {
        origin: "http://localhost:3000",
        cookie: who.cookie,
        "content-type": "application/json",
        "x-citame-generation": generation,
      },
      body: JSON.stringify(payload),
    });
  expect((await save("previous-history")).status).toBe(409);
  expect((await save(statement.generation, receptionist)).status).toBe(403);
  const first = await save(statement.generation);
  expect(first.status, await first.clone().text()).toBe(201);
  expect(await (await save(statement.generation)).json()).toEqual(await first.json());
  expect((await save(statement.generation, owner, { ...packet, points: 90 })).status).toBe(409);
  const current = adminLoyaltyStatementSchema.parse(await (await call(owner, path)).json());
  expect(current.availablePoints).toBe(50);
  expect(current.movements).toHaveLength(1);
});

test("a coupon has current terms, dates, per-customer/global limits and concurrent reservation protection", async () => {
  const code = `WELCOME_${key().slice(0, 8).toUpperCase()}`;
  const promo = await call(owner, "/admin/rewards/promotions", "POST", {
    code,
    name: "Welcome offer",
    kind: "percent",
    value: 1000,
    usageLimit: 1,
    perClientLimit: 1,
  });
  expect(promo.status, await promo.clone().text()).toBe(201);
  const [a, b] = await Promise.all([sale(), sale()]);
  const apply = (id: string) =>
    call(client, `/me/checkouts/${id}/reward`, "POST", {
      kind: "promotion",
      code,
      expectedTotalCents: 10000,
      expectedDiscountCents: 1000,
      idempotencyKey: key(),
    });
  const initial = await pull(t, owner);
  const outcomes = await Promise.all([apply(a.id), apply(b.id)]);
  expect(outcomes.map((r) => r.status).sort()).toEqual([200, 409]);
  const held = await pull(t, owner, { since: initial.headSeq, promotionViews: "1" });
  expect(held.refresh).toContain("promotions");
  const used = outcomes[0]?.status === 200 ? a.id : b.id;
  const unused = used === a.id ? b.id : a.id;
  expect((await call(owner, `/admin/commerce/checkouts/${used}/void`, "POST", {})).status).toBe(
    200,
  );
  const released = await pull(t, owner, { since: held.headSeq, promotionViews: "1" });
  expect(released.refresh).toContain("promotions");
  expect((await apply(unused)).status).toBe(200);
});

test("promotion retries preserve the same code and time ranges use instants rather than offset text ordering", async () => {
  const body = {
    code: "OFFSET_VALID",
    name: "Time-limited offer",
    kind: "fixed",
    value: 500,
    startsAt: "2030-01-01T10:00:00+02:00",
    endsAt: "2030-01-01T09:00:00Z",
  };
  const first = await call(owner, "/admin/rewards/promotions", "POST", body);
  expect(first.status, await first.clone().text()).toBe(201);
  const again = await call(owner, "/admin/rewards/promotions", "POST", body);
  expect(again.status, await again.clone().text()).toBe(201);
  expect(((await again.json()) as { id: string }).id).toBe(
    ((await first.json()) as { id: string }).id,
  );
  expect(
    (
      await call(owner, "/admin/rewards/promotions", "POST", {
        ...body,
        code: "OFFSET_INVALID",
        startsAt: "2030-01-01T10:00:00Z",
        endsAt: "2030-01-01T11:00:00+02:00",
      })
    ).status,
  ).toBe(400);
});

test("desktop can confirm the exact promotion save after its scoped service was disabled", async () => {
  const path = "/admin/rewards/promotions";
  const body = {
    code: "VISIBLE_SCOPE",
    name: "Reviewed service promotion",
    kind: "fixed",
    value: 500,
    serviceIds: [f.haircutId],
  };
  const save = (
    pathname: string,
    method: string,
    payload: unknown,
    generation = t.config.syncReplicaGeneration,
  ) =>
    t.app.request(pathname, {
      method,
      headers: {
        origin: "http://localhost:3000",
        cookie: owner.cookie,
        "content-type": "application/json",
        "x-citame-generation": generation,
      },
      body: JSON.stringify(payload),
    });
  const created = await save(path, "POST", body);
  expect(created.status, await created.clone().text()).toBe(201);
  const original = (await created.json()) as { id: string; version: number };
  const detail = `${path}/${original.id}`;
  const edit = { ...body, value: 600, version: original.version };
  expect((await save(detail, "PUT", edit)).status).toBe(200);
  await t.db.update(service).set({ active: false }).where(eq(service.id, f.haircutId));
  const replay = await save(detail, "PUT", edit);
  expect(replay.status, await replay.clone().text()).toBe(200);
  expect(await replay.json()).toMatchObject({ version: original.version + 1, value: 600 });
  expect((await save(detail, "PUT", edit, "old-replica")).status).toBe(409);
  const fresh = await save(detail, "PUT", { ...edit, value: 700, version: original.version + 1 });
  expect(fresh.status).toBe(404);
});

test("fully point-funded receipts have an explicit manager return without a fictitious cash refund", async () => {
  const p = await call(owner, "/admin/rewards/policy", "PUT", {
    ...policy,
    maximumDiscountBasisPoints: 10000,
  });
  expect(p.status).toBe(200);
  await credit(1000);
  const target = await sale();
  await redeem(target.id, 1000);
  const receipt = await (await call(client, `/me/checkouts/${target.id}`)).json();
  expect(receipt).toMatchObject({ status: "paid", totalCents: 0, payments: [] });
  expect(
    (
      await call(client, `/me/checkouts/${target.id}/reward/return`, "POST", {
        reason: "Return all points",
      })
    ).status,
  ).toBe(403);
  const response = await call(
    owner,
    `/admin/commerce/checkouts/${target.id}/reward/return`,
    "POST",
    { reason: "Entire point-funded service returned" },
  );
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await balance()).toMatchObject({ availablePoints: 1000, reservedPoints: 0 });
  expect(
    (
      await call(owner, `/admin/commerce/checkouts/${target.id}/reward/return`, "POST", {
        reason: "Entire point-funded service returned",
      })
    ).status,
  ).toBe(200);
  expect((await balance()).availablePoints).toBe(1000);
});

test("an abandoned reward cannot be paid after expiry and concurrent cleanup releases its points once", async () => {
  await enable();
  await credit();
  const target = await sale();
  await redeem(target.id);
  await t.db
    .update(checkoutReward)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(checkoutReward.checkoutId, target.id));
  expect((await pay(target.id, 9000)).status).toBe(409);
  const { expireRewardReservations } = await import("./expiry");
  const outcomes = await Promise.all([
    expireRewardReservations(t.db),
    expireRewardReservations(t.db),
  ]);
  expect(outcomes.reduce((a, b) => a + b, 0)).toBe(1);
  expect(await balance()).toMatchObject({ availablePoints: 100, reservedPoints: 0 });
  expect(await (await call(client, `/me/checkouts/${target.id}`)).json()).toMatchObject({
    status: "void",
    balanceCents: 0,
    reward: { state: "released" },
  });
});

test("refunding every partial payment before fulfillment releases the unused points and closes that receipt", async () => {
  await enable();
  await credit();
  const target = await sale();
  await redeem(target.id);
  const partial = await pay(target.id, 1000);
  expect(partial.status).toBe(201);
  const paymentId = ((await partial.json()) as { payment: { id: string } }).payment.id;
  expect((await refund(paymentId, 1000)).status).toBe(201);
  expect(await balance()).toMatchObject({ availablePoints: 100, reservedPoints: 0 });
  expect(await (await call(client, `/me/checkouts/${target.id}`)).json()).toMatchObject({
    status: "void",
    fulfilledAt: null,
  });
});

test("a booked visit keeps its reserved reward until it is cancelled instead of expiring a valid appointment benefit", async () => {
  await enable();
  await credit();
  await t.db.update(service).set({ currency: "EUR" }).where(eq(service.id, f.haircutId));
  const booked = await call(client, "/appointments", "POST", {
    staffId: f.anaId,
    serviceIds: [f.haircutId],
    startsAt: "2026-03-09T12:00:00.000Z",
  });
  expect(booked.status, await booked.clone().text()).toBe(201);
  const a = (await booked.json()) as { id: string; version: number };
  const created = await call(client, "/me/checkouts", "POST", {
    appointmentId: a.id,
    idempotencyKey: key(),
  });
  const target = (await created.json()) as { id: string };
  await redeem(target.id);
  await t.db
    .update(checkoutReward)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(checkoutReward.checkoutId, target.id));
  const { expireRewardReservations } = await import("./expiry");
  expect(await expireRewardReservations(t.db)).toBe(0);
  expect((await balance()).reservedPoints).toBe(100);
  expect(
    (
      await call(client, `/appointments/${a.id}`, "PATCH", {
        version: a.version,
        status: "cancelled",
      })
    ).status,
  ).toBe(200);
  expect(await balance()).toMatchObject({ availablePoints: 100, reservedPoints: 0 });
});

test("professionals can quote the customer's point balance without reading another professional's sale history", async () => {
  await enable();
  const professional = await actor(t, "staff", "professional@rewards.test", {
    staffProfileId: f.anaId,
  });
  const created = await call(owner, "/admin/commerce/checkouts", "POST", {
    clientId: client.clientId,
    staffId: f.beaId,
    lines: [
      {
        kind: "custom",
        description: "Private other-stylist sale",
        quantity: 1,
        unitAmountCents: 10000,
      },
    ],
    idempotencyKey: key(),
  });
  const otherSale = (await created.json()) as { id: string };
  expect((await pay(otherSale.id, 10000)).status).toBe(201);
  const response = await call(professional, `/admin/rewards/clients/${client.clientId}`);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    availablePoints: 100,
    movements: [],
    pagination: { total: 0 },
  });
  expect(
    (
      await call(professional, `/admin/commerce/checkouts/${otherSale.id}/reward/quote`, "POST", {
        kind: "points",
        points: 1,
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await call(professional, `/admin/rewards/clients/${client.clientId}/adjustments`, "POST", {
        points: 1,
        reason: "Unauthorized loyalty credit",
        idempotencyKey: key(),
      })
    ).status,
  ).toBe(403);
});

test("a global coupon limit also serializes different customer accounts", async () => {
  expect(
    (
      await call(owner, "/admin/rewards/promotions", "POST", {
        code: "GLOBAL_LIMIT",
        name: "One global offer",
        kind: "percent",
        value: 1000,
        usageLimit: 1,
        perClientLimit: null,
      })
    ).status,
  ).toBe(201);
  const [a, b] = await Promise.all([sale(), sale(10000, other)]);
  const apply = (id: string, who: Actor) =>
    call(who, `/me/checkouts/${id}/reward`, "POST", {
      kind: "promotion",
      code: "GLOBAL_LIMIT",
      expectedTotalCents: 10000,
      expectedDiscountCents: 1000,
      idempotencyKey: key(),
    });
  const responses = await Promise.all([apply(a.id, client), apply(b.id, other)]);
  expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
});

test("forged or stale discount quotes leave the points account and receipt untouched", async () => {
  await enable();
  await credit();
  const target = await sale();
  for (const terms of [
    { expectedTotalCents: 10000, expectedDiscountCents: 1 },
    { expectedTotalCents: 9999, expectedDiscountCents: 1000 },
  ])
    expect(
      (
        await call(client, `/me/checkouts/${target.id}/reward`, "POST", {
          kind: "points",
          points: 100,
          ...terms,
          idempotencyKey: key(),
        })
      ).status,
    ).toBe(409);
  expect(await balance()).toMatchObject({ availablePoints: 100, reservedPoints: 0 });
  expect(await (await call(client, `/me/checkouts/${target.id}`)).json()).toMatchObject({
    totalCents: 10000,
    discountCents: 0,
    reward: null,
  });
});

test("prepaid visits cannot consume a points-discounted service without providing the promised monetary saving", async () => {
  await enable();
  await credit();
  await t.db.update(service).set({ currency: "EUR" }).where(eq(service.id, f.haircutId));
  const planResponse = await call(owner, "/admin/benefit-plans", "POST", {
    name: "Two service visits",
    kind: "package",
    priceCents: 10000,
    includedUses: 2,
    serviceIds: [f.haircutId],
    idempotencyKey: key(),
  });
  expect(planResponse.status).toBe(201);
  const plan = (await planResponse.json()) as { id: string };
  const purchaseResponse = await call(owner, "/admin/passes", "POST", {
    planId: plan.id,
    clientId: client.clientId,
    idempotencyKey: key(),
  });
  expect(purchaseResponse.status).toBe(201);
  const purchase = (await purchaseResponse.json()) as {
    checkout: { id: string };
    pass: { periods: { id: string }[] };
  };
  expect((await pay(purchase.checkout.id, 10000)).status).toBe(201);
  expect((await balance()).availablePoints).toBe(100);
  if (!client.clientId) throw new Error("Missing customer");
  const startsAt = new Date(Date.now() + 86400000);
  const [a] = await t.db
    .insert(appointment)
    .values({
      staffId: f.anaId,
      clientId: client.clientId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 3600000),
    })
    .returning();
  if (!a) throw new Error("Missing booking");
  await t.db.insert(appointmentService).values({
    appointmentId: a.id,
    serviceId: f.haircutId,
    position: 0,
    name: "Haircut",
    durationMinutes: 45,
    bufferMinutes: 15,
    priceCents: 10000,
    currency: "EUR",
  });
  const created = await call(client, "/me/checkouts", "POST", {
    appointmentId: a.id,
    idempotencyKey: key(),
  });
  const target = (await created.json()) as { id: string; lines: { id: string }[] };
  await redeem(target.id);
  const period = purchase.pass.periods[0];
  const line = target.lines[0];
  if (!period || !line) throw new Error("Missing pass/receipt fixture");
  const response = await call(client, `/me/checkouts/${target.id}/payments`, "POST", {
    method: "package",
    passPeriodId: period.id,
    checkoutLineId: line.id,
    amountCents: 9000,
    idempotencyKey: key(),
  });
  expect(response.status).toBe(409);
  expect(
    (await call(owner, `/admin/commerce/checkouts/${target.id}/void`, "POST", {})).status,
  ).toBe(200);
  const freshResponse = await call(client, "/me/checkouts", "POST", {
    appointmentId: a.id,
    idempotencyKey: key(),
  });
  const fresh = (await freshResponse.json()) as { id: string; lines: { id: string }[] };
  const freshLine = fresh.lines[0];
  if (!freshLine) throw new Error("Missing replacement service line");
  const used = await call(client, `/me/checkouts/${fresh.id}/payments`, "POST", {
    method: "package",
    passPeriodId: period.id,
    checkoutLineId: freshLine.id,
    amountCents: 10000,
    idempotencyKey: key(),
  });
  expect(used.status, await used.clone().text()).toBe(201);
  expect((await balance()).availablePoints).toBe(150);
  const paymentId = ((await used.json()) as { payment: { id: string } }).payment.id;
  expect((await refund(paymentId, 10000)).status).toBe(201);
  expect((await balance()).availablePoints).toBe(100);
});

test("a percentage offer handles the supported gross range above the payable limit without an invented discount cap", async () => {
  expect(
    (
      await call(owner, "/admin/rewards/promotions", "POST", {
        code: "FULL_VALID_GROSS",
        name: "Fully covered eligible bill",
        kind: "percent",
        value: 10000,
      })
    ).status,
  ).toBe(201);
  const [bill] = await t.db
    .insert(checkout)
    .values({
      clientId: client.clientId,
      staffId: f.anaId,
      subtotalCents: 2000000000,
      discountCents: 1100000000,
      totalCents: 900000000,
      createdBy: owner.userId,
      idempotencyKey: key(),
      requestHash: "valid-member-price-fixture",
    })
    .returning();
  if (!bill) throw new Error("Missing gross-range fixture");
  await t.db.insert(checkoutLine).values({
    checkoutId: bill.id,
    kind: "custom",
    description: "Supported discounted gross fixture",
    quantity: 4,
    unitAmountCents: 500000000,
    discountCents: 1100000000,
  });
  const response = await call(client, `/me/checkouts/${bill.id}/reward/quote`, "POST", {
    kind: "promotion",
    code: "FULL_VALID_GROSS",
  });
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await response.json()).toMatchObject({ discountCents: 900000000, newTotalCents: 0 });
});
