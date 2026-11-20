import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { benefitPlanSchema, passContractSchema, passPurchaseResponseSchema } from "@sob/contracts";
import {
  appointment,
  appointmentService,
  passContract,
  passPeriod,
  service,
  staffProfile,
} from "@sob/db";
import { eq, sql } from "drizzle-orm";
import {
  type Actor,
  actor,
  type Fixtures,
  json,
  seedFixtures,
  setupApiTest,
} from "../../../test/helpers";
import { RedsysGateway } from "../../payments/redsys";
import type { PaymentGateway } from "../../payments/types";

let bankOutcome: "success" | "failed" | "unknown" = "success";
let bankDispatches = 0;
let t: Awaited<ReturnType<typeof setupApiTest>>;
let f: Fixtures;
let owner: Actor;
let client: Actor;
let other: Actor;
const key = () => crypto.randomUUID();
function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("Required test fixture missing");
  return value;
}
const call = (who: Actor, path: string, method = "GET", body?: unknown) =>
  json(t.app, path, method, body, who.cookie);
const prefix = (who: Actor) => (who === client || who === other ? "/me" : "/admin");
async function plan(extra: Record<string, unknown> = {}) {
  const response = await call(owner, "/admin/benefit-plans", "POST", {
    name: "Three visits",
    kind: "package",
    priceCents: 1000,
    includedUses: 3,
    serviceIds: [f.haircutId],
    idempotencyKey: key(),
    ...extra,
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return benefitPlanSchema.parse(await response.json());
}
async function purchase(planId: string, who = owner, extra: Record<string, unknown> = {}) {
  const response = await call(who, `${prefix(who)}/passes`, "POST", {
    planId,
    ...(who === owner ? { clientId: client.clientId } : {}),
    idempotencyKey: key(),
    ...extra,
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return passPurchaseResponseSchema.parse(await response.json());
}
async function pay(
  id: string,
  amountCents: number,
  extra: Record<string, unknown> = {},
  who = owner,
) {
  return call(
    who,
    `${who === client || who === other ? "/me" : "/admin/commerce"}/checkouts/${id}/payments`,
    "POST",
    { method: "external_card", amountCents, idempotencyKey: key(), ...extra },
  );
}
async function paid(extra: Record<string, unknown> = {}) {
  const p = await plan(extra);
  const bought = await purchase(p.id);
  const response = await pay(bought.checkout.id, p.priceCents);
  expect(response.status, await response.clone().text()).toBe(201);
  return { ...bought, payment: ((await response.json()) as { payment: { id: string } }).payment };
}
async function get(id: string, who = owner) {
  const response = await call(who, `${prefix(who)}/passes/${id}`);
  expect(response.status).toBe(200);
  return passContractSchema.parse(await response.json());
}
async function sale(
  clientId = must(client.clientId),
  serviceId = f.haircutId,
  date = new Date(Date.now() + 86400000),
) {
  const [booking] = await t.db
    .insert(appointment)
    .values({
      staffId: f.anaId,
      clientId,
      startsAt: date,
      endsAt: new Date(date.getTime() + 3600000),
    })
    .returning();
  await t.db.insert(appointmentService).values({
    appointmentId: must(booking).id,
    serviceId,
    position: 0,
    name: "Haircut",
    durationMinutes: 45,
    bufferMinutes: 15,
    priceCents: 2000,
    currency: "EUR",
  });
  const response = await call(owner, "/admin/commerce/checkouts", "POST", {
    appointmentId: must(booking).id,
    idempotencyKey: key(),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as { id: string; totalCents: number; lines: { id: string }[] };
}
const refund = (id: string, amountCents: number, idempotencyKey = key()) =>
  call(owner, `/admin/commerce/payments/${id}/refunds`, "POST", {
    amountCents,
    reason: "Customer return",
    idempotencyKey,
  });
beforeAll(async () => {
  const bank = new RedsysGateway({
    secret: "sq7HjrUOBfKmC576ILgskD5srU870gJ7",
    merchantCode: "999008881",
    terminal: "001",
    environment: "test",
    publicURL: "http://localhost:3000",
  });
  const gateway: PaymentGateway = {
    provider: "redsys",
    environment: "test",
    checkout: (i) => bank.checkout(i),
    verify: (f, t) => bank.verify(f, t),
    refund: async (i) => {
      bankDispatches++;
      if (bankOutcome === "unknown") throw new Error("Lost bank response");
      return {
        order: i.order,
        amountCents: i.amountCents,
        currency: "EUR",
        transactionType: "3",
        responseCode: bankOutcome === "success" ? "0900" : "0190",
        success: bankOutcome === "success",
        authorizationCode: null,
      };
    },
  };
  t = await setupApiTest({ dbSuffix: "passes", deps: { paymentGateway: gateway } });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  bankOutcome = "success";
  bankDispatches = 0;
  await t.reset();
  f = await seedFixtures(t.db);
  await t.db.update(service).set({ currency: "EUR" });
  [owner, client, other] = await Promise.all([
    actor(t, "owner", "pass-owner@example.com"),
    actor(t, "client", "pass-client@example.com"),
    actor(t, "client", "pass-other@example.com"),
  ]);
});

test("plans validate services, require catalog permission and fence edits without resetting optional fields", async () => {
  expect((await call(client, "/admin/benefit-plans", "POST", {})).status).toBe(403);
  const p = await plan({ description: "Original terms", validityDays: 60 });
  const response = await call(owner, `/admin/benefit-plans/${p.id}`, "PATCH", {
    name: "Updated",
    version: p.version,
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    name: "Updated",
    description: "Original terms",
    validityDays: 60,
    version: 2,
  });
  expect(
    (await call(owner, `/admin/benefit-plans/${p.id}`, "PATCH", { priceCents: 2000, version: 1 }))
      .status,
  ).toBe(409);
  expect(
    (
      await call(owner, "/admin/benefit-plans", "POST", {
        name: "Invalid",
        kind: "package",
        priceCents: 10,
        includedUses: 1,
        serviceIds: [key()],
        idempotencyKey: key(),
      })
    ).status,
  ).toBe(404);
});
test("purchase is atomic and idempotent, freezes terms and activates only after full payment", async () => {
  const p = await plan();
  const replay = key();
  const bought = await purchase(p.id, client, { idempotencyKey: replay });
  expect((await purchase(p.id, client, { idempotencyKey: replay })).pass.id).toBe(bought.pass.id);
  expect(bought.period).toMatchObject({ status: "pending", availableUses: 0 });
  await call(owner, `/admin/benefit-plans/${p.id}`, "PATCH", {
    priceCents: 2000,
    includedUses: 2,
    active: false,
    version: 1,
  });
  expect((await purchase(p.id, client, { idempotencyKey: replay })).checkout.totalCents).toBe(1000);
  expect((await pay(bought.checkout.id, 999)).status).toBe(201);
  expect((await get(bought.pass.id)).periods[0]?.availableUses).toBe(0);
  expect((await pay(bought.checkout.id, 1)).status).toBe(201);
  expect((await get(bought.pass.id)).periods[0]).toMatchObject({
    status: "active",
    availableUses: 3,
    remainingAllocationCents: 1000,
  });
  const rows = await t.db.execute<{ amount: number }>(
    sql`select allocated_cents as amount from pass_unit order by ordinal`,
  );
  expect(rows.map((r) => r.amount)).toEqual([334, 333, 333]);
  expect((await call(other, `/me/passes/${bought.pass.id}`)).status).toBe(404);
  expect(
    (
      await call(client, "/me/passes", "POST", {
        planId: p.id,
        priceCents: 1,
        idempotencyKey: key(),
      })
    ).status,
  ).toBe(400);
});
test("concurrent visits cannot consume the same entitlement and tender replay is stable", async () => {
  const bought = await paid({ includedUses: 1 });
  const [a, b] = [
    await sale(),
    await sale(must(client.clientId), f.haircutId, new Date(Date.now() + 172800000)),
  ];
  const request = key();
  const tender = (s: typeof a, idempotencyKey: string) =>
    pay(
      s.id,
      2000,
      {
        method: "package",
        passPeriodId: bought.period.id,
        checkoutLineId: must(s.lines[0]).id,
        idempotencyKey,
      },
      client,
    );
  const results = await Promise.all([tender(a, request), tender(b, key())]);
  expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  if (must(results[0]).status === 201) expect((await tender(a, request)).status).toBe(201);
  expect((await get(bought.pass.id)).periods[0]).toMatchObject({
    availableUses: 0,
    usedUses: 1,
    remainingAllocationCents: 0,
  });
});
test("eligibility checks buyer, service date, currency, pending state and full line amount", async () => {
  const bought = await paid({ validityDays: 2 });
  const s = await sale();
  const data = {
    method: "package",
    passPeriodId: bought.period.id,
    checkoutLineId: must(s.lines[0]).id,
  };
  expect((await pay(s.id, 1999, data, client)).status).toBe(409);
  expect((await pay(s.id, 2000, data, other)).status).toBe(404);
  const future = await sale(
    must(client.clientId),
    f.haircutId,
    new Date(Date.now() + 4 * 86400000),
  );
  expect(
    (await pay(future.id, 2000, { ...data, checkoutLineId: must(future.lines[0]).id })).status,
  ).toBe(409);
  const color = await sale(must(client.clientId), f.colorId, new Date(Date.now() + 3 * 3600000));
  expect(
    (await pay(color.id, 2000, { ...data, checkoutLineId: must(color.lines[0]).id })).status,
  ).toBe(409);
  expect((await get(bought.pass.id)).periods[0]?.availableUses).toBe(3);
});
test("full tender refund restores its original penny allocation once and rejects partial visits", async () => {
  const bought = await paid();
  const s = await sale();
  const response = await pay(s.id, 2000, {
    method: "package",
    passPeriodId: bought.period.id,
    checkoutLineId: must(s.lines[0]).id,
  });
  expect(response.status).toBe(201);
  const p = ((await response.json()) as { payment: { id: string } }).payment;
  expect((await refund(p.id, 1000)).status).toBe(409);
  const request = key();
  expect((await refund(p.id, 2000, request)).status).toBe(201);
  expect((await refund(p.id, 2000, request)).status).toBe(201);
  expect((await get(bought.pass.id)).periods[0]).toMatchObject({
    availableUses: 3,
    usedUses: 0,
    remainingAllocationCents: 1000,
  });
});
test("purchase refunds reserve whole unused visits and cannot refund consumed allocations", async () => {
  const bought = await paid();
  const s = await sale();
  expect(
    (
      await pay(s.id, 2000, {
        method: "package",
        passPeriodId: bought.period.id,
        checkoutLineId: must(s.lines[0]).id,
      })
    ).status,
  ).toBe(201);
  expect((await refund(bought.payment.id, 334)).status).toBe(409);
  const quote = await call(owner, "/admin/passes/refund-quote", "POST", {
    periodId: bought.period.id,
    paymentId: bought.payment.id,
    unitCount: 2,
  });
  expect(quote.status).toBe(200);
  expect(await quote.json()).toMatchObject({ amountCents: 666, unitCount: 2, availableUses: 2 });
  expect((await refund(bought.payment.id, 666)).status).toBe(201);
  expect((await get(bought.pass.id)).periods[0]).toMatchObject({
    availableUses: 0,
    usedUses: 1,
    returnedUses: 2,
    remainingAllocationCents: 0,
  });
  expect((await refund(bought.payment.id, 1)).status).toBe(409);
});
test("membership periods follow the original billing anchor, manual renewal is unique and cancellation preserves paid visits", async () => {
  const bought = await paid({ kind: "membership", periodMonths: 1, includedUses: 2 });
  const [a, b] = await Promise.all([
    call(client, `/me/passes/${bought.pass.id}/renew`, "POST", { idempotencyKey: key() }),
    call(client, `/me/passes/${bought.pass.id}/renew`, "POST", { idempotencyKey: key() }),
  ]);
  expect(a.status).toBe(201);
  expect(b.status).toBe(201);
  const renewed = passPurchaseResponseSchema.parse(await a.json());
  expect(passPurchaseResponseSchema.parse(await b.json()).period.id).toBe(renewed.period.id);
  expect(renewed.period.index).toBe(1);
  expect((await pay(renewed.checkout.id, 1000)).status).toBe(201);
  const contract = await get(bought.pass.id);
  expect(contract.periods).toHaveLength(2);
  expect(contract.periods.find((p) => p.index === 1)?.status).toBe("upcoming");
  const response = await call(client, `/me/passes/${bought.pass.id}/cancel`, "POST", {
    version: contract.version,
    reason: "Stop membership renewal",
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ cancelAtPeriodEnd: true, autoPayReady: false });
  expect(
    (await call(client, `/me/passes/${bought.pass.id}/renew`, "POST", { idempotencyKey: key() }))
      .status,
  ).toBe(409);
  expect((await get(bought.pass.id)).periods[0]?.availableUses).toBe(2);
});
test("membership discounts apply only to eligible services and never change existing receipts", async () => {
  const bought = await paid({
    kind: "membership",
    periodMonths: 1,
    includedUses: 0,
    discountBasisPoints: 2000,
  });
  const s = await sale();
  expect(s.totalCents).toBe(1600);
  expect((await refund(bought.payment.id, 1000)).status).toBe(201);
  const next = await sale(must(client.clientId), f.haircutId, new Date(Date.now() + 172800000));
  expect(next.totalCents).toBe(2000);
  const existing = await call(owner, `/admin/commerce/checkouts/${s.id}`);
  expect(((await existing.json()) as { totalCents: number }).totalCents).toBe(1600);
});
test("pass commission uses allocated money rather than the higher catalog face value", async () => {
  await call(owner, `/admin/accounting/staff/${f.anaId}/policy`, "PUT", {
    serviceBasisPoints: 5000,
    productBasisPoints: 0,
    version: null,
  });
  const bought = await paid();
  const s = await sale();
  const response = await pay(s.id, 2000, {
    method: "package",
    passPeriodId: bought.period.id,
    checkoutLineId: must(s.lines[0]).id,
  });
  expect(response.status).toBe(201);
  const rows = await t.db.execute<{ basis: number; earned: number }>(
    sql`select basis_cents as basis, earned_cents as earned from commission_accrual`,
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ basis: 334, earned: 167 });
});

test("unknown bank refunds hold unused visits, dispatch once and release only after explicit reconciliation", async () => {
  const bought = await paid();
  await t.db.execute(
    sql`update checkout_payment set method='redsys_card', bank_order='1234abcdefff' where id=${bought.payment.id}`,
  );
  const r = await refund(bought.payment.id, 334);
  expect(r.status).toBe(201);
  const returned = (await r.json()) as { id: string };
  expect((await get(bought.pass.id)).periods[0]).toMatchObject({
    availableUses: 2,
    heldUses: 1,
    returnedUses: 0,
  });
  bankOutcome = "unknown";
  expect(
    (await call(owner, `/admin/commerce/refunds/${returned.id}/execute`, "POST", {})).status,
  ).toBe(200);
  expect(
    (await call(owner, `/admin/commerce/refunds/${returned.id}/execute`, "POST", {})).status,
  ).toBe(200);
  expect(bankDispatches).toBe(1);
  expect((await get(bought.pass.id)).periods[0]?.heldUses).toBe(1);
  await t.db.execute(
    sql`update checkout_refund set updated_at=now()-interval '2 minutes' where id=${returned.id}`,
  );
  const response = await call(owner, `/admin/commerce/refunds/${returned.id}/reconcile`, "POST", {
    outcome: "failed",
    reference: "BANK-PORTAL-DECLINED",
  });
  expect(response.status).toBe(200);
  expect((await get(bought.pass.id)).periods[0]).toMatchObject({
    availableUses: 3,
    heldUses: 0,
    remainingAllocationCents: 1000,
  });
});

test("cancelling an unsent bank refund releases its held pass visits", async () => {
  const bought = await paid();
  await t.db.execute(
    sql`update checkout_payment set method='redsys_card', bank_order='1234abcdefff' where id=${bought.payment.id}`,
  );
  const response = await refund(bought.payment.id, 334);
  expect(response.status).toBe(201);
  const { id } = (await response.json()) as { id: string };
  expect((await get(bought.pass.id)).periods[0]?.heldUses).toBe(1);
  expect((await call(owner, `/admin/commerce/refunds/${id}/cancel`, "POST", {})).status).toBe(200);
  expect((await get(bought.pass.id)).periods[0]).toMatchObject({
    availableUses: 3,
    heldUses: 0,
    returnedUses: 0,
  });
  expect(bankDispatches).toBe(0);
});
test("competing purchase returns and service use cannot spend the same visits", async () => {
  const bought = await paid({ includedUses: 1 });
  const saleData = await sale();
  const result = await Promise.all([
    refund(bought.payment.id, 1000),
    pay(saleData.id, 2000, {
      method: "package",
      passPeriodId: bought.period.id,
      checkoutLineId: must(saleData.lines[0]).id,
    }),
  ]);
  expect(result.map((r) => r.status).sort()).toEqual([201, 409]);
  const period = must((await get(bought.pass.id)).periods[0]);
  expect(period.availableUses).toBe(0);
  expect(period.usedUses + period.returnedUses).toBe(1);
});
test("fully returned periods and unpaid void purchases cannot regain spendable visits", async () => {
  const bought = await paid();
  expect((await refund(bought.payment.id, 1000)).status).toBe(201);
  expect((await get(bought.pass.id)).periods[0]?.status).toBe("void");
  const pending = await purchase(bought.pass.planId);
  expect(
    (await call(owner, `/admin/commerce/checkouts/${pending.checkout.id}/void`, "POST", {})).status,
  ).toBe(200);
  expect((await get(pending.pass.id)).status).toBe("void");
});
test("restricted staff cannot use customer aliases to create, inspect or renew passes", async () => {
  const bought = await paid();
  const staff = await actor(t, "staff", "pass-restricted@example.com", { staffProfileId: f.anaId });
  await t.db
    .update(staffProfile)
    .set({ accessPreset: "restricted" })
    .where(eq(staffProfile.id, f.anaId));
  expect((await call(staff, "/me/passes")).status).toBe(403);
  expect(
    (await call(staff, `/me/passes/${bought.pass.id}/renew`, "POST", { idempotencyKey: key() }))
      .status,
  ).toBe(403);
});
test("automatic renewal cannot be silently enabled without the bank facility and explicit consent", async () => {
  const p = await plan({ kind: "membership", periodMonths: 1, includedUses: 2 });
  expect(
    (
      await call(client, "/me/passes", "POST", {
        planId: p.id,
        renewalMode: "automatic",
        idempotencyKey: key(),
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await call(owner, "/admin/passes", "POST", {
        planId: p.id,
        clientId: client.clientId,
        renewalMode: "automatic",
        acceptRecurring: true,
        consentVersion: "sob.membership-recurring.v1",
        planVersion: p.version,
        idempotencyKey: key(),
      })
    ).status,
  ).toBe(503);
});
test("late manual renewal skips elapsed periods while preserving the original calendar anchor", async () => {
  const bought = await paid({ kind: "membership", periodMonths: 1, includedUses: 2 });
  const anchor = new Date();
  anchor.setUTCMonth(anchor.getUTCMonth() - 4);
  await t.db
    .update(passContract)
    .set({ anchorAt: anchor })
    .where(eq(passContract.id, bought.pass.id));
  await t.db
    .update(passPeriod)
    .set({ startsAt: anchor, endsAt: new Date(anchor.getTime() + 28 * 86400000) })
    .where(eq(passPeriod.id, bought.period.id));
  const response = await call(client, `/me/passes/${bought.pass.id}/renew`, "POST", {
    idempotencyKey: key(),
  });
  expect(response.status).toBe(201);
  const next = passPurchaseResponseSchema.parse(await response.json());
  expect(next.period.index).toBeGreaterThanOrEqual(4);
  expect((await pay(next.checkout.id, 1000)).status).toBe(201);
  expect((await get(bought.pass.id)).periods[0]?.status).toBe("active");
});
test("pending return of an access-only membership suspends new discount quotes", async () => {
  const bought = await paid({
    kind: "membership",
    periodMonths: 1,
    includedUses: 0,
    discountBasisPoints: 2000,
  });
  await t.db.execute(
    sql`update checkout_payment set method='redsys_card',bank_order='1234aaaaeeee' where id=${bought.payment.id}`,
  );
  expect((await refund(bought.payment.id, 1000)).status).toBe(201);
  expect((await sale()).totalCents).toBe(2000);
});
test("renewal paid after its originally proposed cycle starts a current cycle rather than an expired benefit", async () => {
  const bought = await paid({ kind: "membership", periodMonths: 1, includedUses: 2 });
  const response = await call(client, `/me/passes/${bought.pass.id}/renew`, "POST", {
    idempotencyKey: key(),
  });
  const renewed = passPurchaseResponseSchema.parse(await response.json());
  const anchor = new Date();
  anchor.setUTCMonth(anchor.getUTCMonth() - 5);
  await t.db
    .update(passContract)
    .set({ anchorAt: anchor })
    .where(eq(passContract.id, bought.pass.id));
  expect((await pay(renewed.checkout.id, 1000)).status).toBe(201);
  const current = await get(bought.pass.id);
  expect(current.periods[0]?.status).toBe("active");
  expect(current.periods[0]?.index).toBeGreaterThanOrEqual(5);
});
test("financial reports separate new cash, receipt face values and the prepaid amount earned", async () => {
  const bought = await paid();
  const s = await sale();
  const paidResponse = await pay(s.id, 2000, {
    method: "package",
    passPeriodId: bought.period.id,
    checkoutLineId: must(s.lines[0]).id,
  });
  expect(paidResponse.status).toBe(201);
  const used = (await paidResponse.json()) as { payment: { id: string } };
  const date = Temporal.Now.plainDateISO("America/Argentina/Buenos_Aires").toString();
  const response = await call(owner, `/admin/accounting/sales?from=${date}&to=${date}`);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    collectedCents: 1000,
    refundedCents: 0,
    soldCents: 334,
    prepaidAppliedCents: 2000,
    prepaidAllocatedCents: 334,
  });
  expect((await refund(used.payment.id, 2000)).status).toBe(201);
  const after = await call(owner, `/admin/accounting/sales?from=${date}&to=${date}`);
  expect(await after.json()).toMatchObject({
    refundedCents: 0,
    prepaidReturnedCents: 2000,
    prepaidAllocationReturnedCents: 334,
  });
});
test("returning a pass visit preserves commission on independently paid service lines", async () => {
  await call(owner, `/admin/accounting/staff/${f.anaId}/policy`, "PUT", {
    serviceBasisPoints: 5000,
    productBasisPoints: 0,
    version: null,
  });
  const bought = await paid();
  const s = await sale();
  const [original] = await t.db.select().from(appointment).limit(1);
  if (!original) throw new Error("Missing booking");
  // Add the second service through a fresh immutable appointment snapshot and create a new receipt.
  expect((await call(owner, `/admin/commerce/checkouts/${s.id}/void`, "POST", {})).status).toBe(
    200,
  );
  await t.db.insert(appointmentService).values({
    appointmentId: original.id,
    serviceId: f.colorId,
    position: 1,
    name: "Color",
    durationMinutes: 90,
    bufferMinutes: 0,
    priceCents: 2000,
    currency: "EUR",
  });
  const created = await call(owner, "/admin/commerce/checkouts", "POST", {
    appointmentId: original.id,
    idempotencyKey: key(),
  });
  const receipt = (await created.json()) as {
    id: string;
    lines: { id: string; description: string }[];
  };
  const line = receipt.lines.find((l) => l.description === "Haircut");
  if (!line) throw new Error("Missing haircut");
  const a = await pay(receipt.id, 2000, {
    method: "package",
    passPeriodId: bought.period.id,
    checkoutLineId: line.id,
  });
  expect(a.status).toBe(201);
  const used = (await a.json()) as { payment: { id: string } };
  expect((await pay(receipt.id, 2000)).status).toBe(201);
  expect((await refund(used.payment.id, 2000)).status).toBe(201);
  const statement = await call(owner, `/admin/accounting/staff/${f.anaId}/statement`);
  expect(statement.status).toBe(200);
  expect(await statement.json()).toMatchObject({ earnedCents: 1000 });
});
test("recognition waits for full receipt settlement while tender reservations remain visible", async () => {
  const bought = await paid();
  const s = await sale();
  const [booking] = await t.db.select().from(appointment).limit(1);
  if (!booking) throw new Error("Missing booking");
  await call(owner, `/admin/commerce/checkouts/${s.id}/void`, "POST", {});
  const created = await call(owner, "/admin/commerce/checkouts", "POST", {
    appointmentId: booking.id,
    tipCents: 100,
    idempotencyKey: key(),
  });
  const receipt = (await created.json()) as { id: string; lines: { id: string }[] };
  expect(
    (
      await pay(receipt.id, 2000, {
        method: "package",
        passPeriodId: bought.period.id,
        checkoutLineId: must(receipt.lines[0]).id,
      })
    ).status,
  ).toBe(201);
  const date = Temporal.Now.plainDateISO("America/Argentina/Buenos_Aires").toString();
  const report = async () =>
    await (await call(owner, `/admin/accounting/sales?from=${date}&to=${date}`)).json();
  expect(await report()).toMatchObject({
    prepaidAppliedCents: 2000,
    prepaidAllocatedCents: 0,
    soldCents: 0,
  });
  expect((await pay(receipt.id, 100)).status).toBe(201);
  expect(await report()).toMatchObject({ prepaidAllocatedCents: 334, soldCents: 434 });
});
test("access-only memberships paid by split methods can return each original payment and end discounts", async () => {
  const p = await plan({
    kind: "membership",
    periodMonths: 1,
    includedUses: 0,
    discountBasisPoints: 2000,
  });
  const bought = await purchase(p.id);
  const a = await pay(bought.checkout.id, 500);
  const b = await pay(bought.checkout.id, 500);
  const first = (await a.json()) as { payment: { id: string } };
  const second = (await b.json()) as { payment: { id: string } };
  const quote = await call(owner, "/admin/passes/refund-quote", "POST", {
    periodId: bought.period.id,
    paymentId: first.payment.id,
    unitCount: 0,
  });
  expect(quote.status).toBe(200);
  expect(await quote.json()).toMatchObject({ amountCents: 500 });
  expect((await refund(first.payment.id, 500)).status).toBe(201);
  expect((await get(bought.pass.id)).periods[0]?.status).toBe("void");
  expect((await sale()).totalCents).toBe(2000);
  expect((await refund(second.payment.id, 500)).status).toBe(201);
});
test("access-fee return quotes allocate excess first without exceeding a split payment", async () => {
  const bought = await paid({
    kind: "membership",
    periodMonths: 1,
    includedUses: 0,
    discountBasisPoints: 2000,
  });
  await t.db.execute(
    sql`insert into checkout_payment(id,checkout_id,method,status,amount_cents,currency,idempotency_key,request_hash) values (${key()},${bought.checkout.id},'redsys_card','reconciliation',500,'EUR',${key()},'fixture-late-capture')`,
  );
  const response = await call(owner, "/admin/passes/refund-quote", "POST", {
    periodId: bought.period.id,
    paymentId: bought.payment.id,
    unitCount: 0,
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ amountCents: 1000, excessCents: 500 });
  expect((await refund(bought.payment.id, 1000)).status).toBe(201);
  expect((await get(bought.pass.id)).periods[0]?.status).toBe("void");
});
test("salon pass records identify the buyer without exposing private client notes", async () => {
  await call(owner, `/admin/clients/${client.clientId}`, "PATCH", {
    name: "Known buyer",
    notes: "Private treatment history",
  });
  const p = await plan();
  const bought = await purchase(p.id);
  expect(bought.pass).toMatchObject({ clientName: "Known buyer" });
  expect(JSON.stringify(bought.pass)).not.toContain("Private treatment history");
  await call(owner, `/admin/clients/${client.clientId}`, "PATCH", { name: "Updated buyer" });
  expect(await get(bought.pass.id)).toMatchObject({ clientName: "Updated buyer" });
});

test("package and membership lists filter before pagination and keep client isolation", async () => {
  const pkg = await plan();
  const membership = await plan({ name: "Monthly access", kind: "membership", periodMonths: 1 });
  const first = await purchase(pkg.id);
  const second = await purchase(membership.id);
  const packages = (await (await call(owner, "/admin/passes?kind=package")).json()) as {
    passes: { id: string }[];
    pagination: { total: number };
  };
  expect(packages.passes.map((row) => row.id)).toEqual([first.pass.id]);
  expect(packages.pagination.total).toBe(1);
  const memberships = (await (await call(client, "/me/passes?kind=membership")).json()) as {
    passes: { id: string }[];
    pagination: { total: number };
  };
  expect(memberships.passes.map((row) => row.id)).toEqual([second.pass.id]);
  expect(await (await call(other, "/me/passes?kind=membership")).json()).toMatchObject({
    passes: [],
    pagination: { total: 0 },
  });
  expect((await call(owner, "/admin/passes?kind=invalid")).status).toBe(400);
});
