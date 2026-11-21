import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { appointment, appointmentService, service } from "@sob/db";
import {
  type Actor,
  actor,
  type Fixtures,
  json,
  seedFixtures,
  setupApiTest,
} from "../../../test/helpers";

let t: Awaited<ReturnType<typeof setupApiTest>>;
let owner: Actor;
let customer: Actor;
let other: Actor;
let fixtures: Fixtures;

const program = {
  enabled: true,
  name: "Colour card",
  appearance: "rose",
  goal: 2,
  welcomeStamps: 0,
  qualifyingServiceIds: [] as string[],
  minimumSpendCents: 2500,
  stampExpiryDays: 90,
  expiryFrom: "activity",
  rewardExpiryDays: 30,
  automaticIssue: true,
  awardOn: "checkout",
  terms: "One stamp per eligible settled receipt.",
  reward: {
    name: "Colour treatment discount",
    kind: "service",
    targetId: null,
    discountBasisPoints: 5000,
  },
};
const path = "/admin/rewards/stamps";
const call = (by: Actor, url: string, method = "GET", body?: unknown) =>
  json(t.app, url, method, body, by.cookie);
const generation = () => t.config.syncReplicaGeneration;
const command = () => ({ idempotencyKey: crypto.randomUUID(), generation: generation() });
const save = (changes: Record<string, unknown> = {}) =>
  call(owner, `${path}/program`, "PUT", {
    version: 1,
    existingCards: "keep",
    generation: generation(),
    program: { ...program, ...changes },
  });
const cards = async (by = customer) => {
  const response = await call(by, "/me/loyalty-cards");
  expect(response.status, await response.clone().text()).toBe(200);
  return (
    (await response.json()) as {
      cards: { id: string; stamps: number; state: string; version: number; needsReview: boolean }[];
    }
  ).cards;
};

beforeAll(async () => {
  t = await setupApiTest({ dbSuffix: "stamp_programme" });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  fixtures = await seedFixtures(t.db);
  await t.db.update(service).set({ currency: "EUR" });
  [owner, customer, other] = await Promise.all([
    actor(t, "owner", "owner@stamps.test"),
    actor(t, "client", "customer@stamps.test"),
    actor(t, "client", "other@stamps.test"),
  ]);
});
async function settle(serviceId: string, amountCents = 10_000) {
  const created = await call(owner, "/admin/commerce/checkouts", "POST", {
    clientId: customer.clientId,
    staffId: fixtures.anaId,
    lines: serviceId
      ? [{ kind: "service", serviceId, quantity: 1 }]
      : [
          {
            kind: "custom",
            description: "Synthetic sale",
            unitAmountCents: amountCents,
            quantity: 1,
          },
        ],
    idempotencyKey: crypto.randomUUID(),
  });
  expect(created.status, await created.clone().text()).toBe(201);
  const sale = (await created.json()) as { id: string; totalCents: number };
  const payment = {
    method: "external_card",
    amountCents: sale.totalCents,
    idempotencyKey: crypto.randomUUID(),
  };
  const pay = () => call(owner, `/admin/commerce/checkouts/${sale.id}/payments`, "POST", payment);
  const settled = await pay();
  expect(settled.status, await settled.clone().text()).toBe(201);
  const body = (await settled.json()) as { payment: { id: string } };
  expect((await pay()).status).toBe(201);
  return { receipt: sale.id, payment: body.payment?.id, amount: sale.totalCents };
}

test("qualified settled treatments add one stamp per visit and require reviewed reward issuance", async () => {
  const saved = await save({ qualifyingServiceIds: [fixtures.haircutId] });
  expect(saved.status, await saved.clone().text()).toBe(200);
  await settle(fixtures.colorId);
  expect(await cards()).toEqual([]);
  await settle(fixtures.haircutId);
  expect(await cards()).toMatchObject([{ stamps: 1, state: "active" }]);
  await settle(fixtures.haircutId);
  const all = await cards();
  const completed = all.find((card) => card.state === "completed");
  expect(completed?.stamps).toBe(2);
  expect(all.filter((card) => card.state === "active")).toHaveLength(1);
  expect(await cards(other)).toEqual([]);
  if (!completed) throw new Error("Expected a completed card");
  const action = { type: "issue_reward", version: completed.version, ...command() };
  const apply = (by: Actor, body = action) =>
    call(by, `${path}/cards/${completed.id}`, "POST", body);
  expect((await apply(other)).status).toBe(403);
  expect((await apply(owner, { ...action, generation: "restored" })).status).toBe(409);
  const issued = await apply(owner);
  expect(issued.status, await issued.clone().text()).toBe(200);
  const result = (await issued.json()) as { state: string; version: number };
  expect(result.state).toBe("issued");
  expect(await (await apply(owner)).json()).toMatchObject(result);
  const redeemed = await apply(owner, { type: "redeem", version: result.version, ...command() });
  expect(redeemed.status, await redeemed.clone().text()).toBe(200);
  expect(await redeemed.json()).toMatchObject({ state: "redeemed" });
});

test("a refund below the minimum reverses the original stamp without starting a replacement", async () => {
  expect((await save()).status).toBe(200);
  const receipt = await settle("");
  const before = await cards();
  expect(before).toMatchObject([{ stamps: 1, state: "active" }]);
  const refund = await call(owner, `/admin/commerce/payments/${receipt.payment}/refunds`, "POST", {
    amountCents: receipt.amount,
    reason: "Synthetic return for loyalty",
    idempotencyKey: crypto.randomUUID(),
  });
  expect(refund.status, await refund.clone().text()).toBe(201);
  expect(await cards()).toMatchObject([{ id: before[0]?.id, stamps: 0, state: "active" }]);
});

test("programme updates preserve existing terms and can explicitly invalidate an older card", async () => {
  expect((await save({ automaticIssue: false })).status).toBe(200);
  const issued = await call(owner, `${path}/cards`, "POST", {
    clientId: customer.clientId,
    programVersion: 2,
    initialStamps: 1,
    ...command(),
  });
  expect(issued.status, await issued.clone().text()).toBe(201);
  const policy = (version: number, existingCards: string) =>
    call(owner, `${path}/program`, "PUT", {
      version,
      existingCards,
      generation: generation(),
      program: { ...program, goal: 5 },
    });
  expect((await policy(1, "void")).status).toBe(409);
  expect((await policy(2, "keep")).status).toBe(200);
  expect(await cards()).toMatchObject([{ stamps: 1, state: "active", program: { goal: 2 } }]);
  expect((await policy(3, "void")).status).toBe(200);
  expect(await cards()).toMatchObject([{ stamps: 1, state: "void", program: { goal: 2 } }]);
});

test("completing a visit awards once without a checkout", async () => {
  expect(
    (await save({ awardOn: "appointment", qualifyingServiceIds: [fixtures.haircutId] })).status,
  ).toBe(200);
  const [visit] = await t.db
    .insert(appointment)
    .values({
      staffId: fixtures.anaId,
      clientId: customer.clientId!,
      startsAt: new Date("2026-02-27T09:00:00Z"),
      endsAt: new Date("2026-02-27T10:00:00Z"),
    })
    .returning();
  if (!visit) throw new Error("Missing visit fixture");
  await t.db.insert(appointmentService).values({
    appointmentId: visit.id,
    serviceId: fixtures.haircutId,
    name: "Synthetic eligible visit",
    position: 0,
    durationMinutes: 45,
    bufferMinutes: 15,
    priceCents: 10_000,
    currency: "EUR",
  });
  const complete = await call(owner, `/appointments/${visit.id}`, "PATCH", {
    status: "completed",
    version: 1,
  });
  expect(complete.status, await complete.clone().text()).toBe(200);
  expect(await cards()).toMatchObject([{ stamps: 1, state: "active" }]);
  await settle(fixtures.haircutId);
  expect(await cards()).toMatchObject([{ stamps: 1, state: "active" }]);
});
