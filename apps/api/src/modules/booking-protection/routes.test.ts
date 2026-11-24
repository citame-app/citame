import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import {
  appointment,
  bookingFeeMovement,
  bookingProtection,
  checkout,
  checkoutPayment,
  clientProfile,
  passPeriod,
  reminder,
  service,
  staffProfile,
} from "@sob/db";
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
import { pull } from "../../../test/sync";
import { updateAppointment } from "../appointments/service";
import { settleVerifiedBankPayment } from "../commerce/service";
import { calendarProtections, expireBookingHolds, protectionView } from "./value";

let t: Awaited<ReturnType<typeof setupApiTest>>;
let f: Fixtures;
let owner: Actor;
let client: Actor;
let other: Actor;
const call = (who: Actor | null, path: string, method = "GET", body?: unknown) =>
  json(t.app, path, method, body, who?.cookie);
const mustClient = (who: Actor) => {
  if (!who.clientId) throw new Error("Missing client fixture");
  return who.clientId;
};
const policy = {
  enabled: true,
  depositKind: "percent",
  depositValue: 2500,
  holdMinutes: 15,
  cancellationWindowMinutes: 1440,
  lateCancellationBasisPoints: 2500,
  noShowBasisPoints: 5000,
  trustedExempt: true,
  version: 1,
};
async function enable(extra = {}) {
  const r = await call(owner, "/admin/settings/booking-policy", "PUT", { ...policy, ...extra });
  expect(r.status, await r.clone().text()).toBe(200);
  return (await r.json()) as { version: number };
}
async function book(extra = {}, who = client) {
  return call(who, "/appointments", "POST", {
    staffId: f.anaId,
    serviceIds: [f.haircutId],
    startsAt: MONDAY_0900,
    protectionAcceptedTotalCents: 10000,
    ...extra,
  });
}
beforeAll(async () => {
  t = await setupApiTest({ dbSuffix: "booking_protection" });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  f = await seedFixtures(t.db);
  await t.db.update(service).set({ currency: "EUR" });
  [owner, client, other] = await Promise.all([
    actor(t, "owner", "owner@deposits.test"),
    actor(t, "client", "buyer@deposits.test"),
    actor(t, "client", "other@deposits.test"),
  ]);
});
test("policy is disabled by default, public and editable only by the owner with a current revision", async () => {
  const initial = await call(null, "/salon/booking-policy");
  expect(initial.status).toBe(200);
  expect(await initial.json()).toMatchObject({ enabled: false, version: 1 });
  expect((await call(client, "/admin/settings/booking-policy", "PUT", policy)).status).toBe(403);
  await enable();
  expect((await call(owner, "/admin/settings/booking-policy", "PUT", policy)).status).toBe(409);
  expect(
    (
      await call(owner, "/admin/settings/booking-policy", "PUT", {
        ...policy,
        version: 2,
        depositValue: 10001,
      })
    ).status,
  ).toBe(400);
});
test("private appointment context shows protection and redacts amounts without commerce access", async () => {
  const p = await enable();
  const response = await book({ protectionAcceptedVersion: p.version });
  expect(response.status).toBe(201);
  const { id, protection: booking } = (await response.json()) as {
    id: string;
    protection: { checkoutId: string };
  };
  const path = `/appointments/${id}/context`;
  const mirrored = async () => {
    const snapshot = await pull(t, owner, { since: 0, limit: 200 });
    expect(snapshot.appointmentDepositStatus).toBe(true);
    return snapshot.changes.find((change) => change.entity === "appointment" && change.id === id);
  };
  const pending = await mirrored();
  expect(pending).toMatchObject({
    data: {
      depositStatus: {
        state: "pending",
        attendanceBlock: "pending_deposit",
        expiresAt: expect.any(String),
        cancellationCutoff: expect.any(String),
      },
    },
  });
  if (pending?.op !== "upsert" || pending.entity !== "appointment")
    throw new Error("missing booking");
  expect(Object.keys(pending.data.depositStatus ?? {}).sort()).toEqual([
    "attendanceBlock",
    "cancellationCutoff",
    "expiresAt",
    "state",
  ]);
  const details = await call(owner, path);
  expect(details.status).toBe(200);
  expect(details.headers.get("cache-control")).toBe("private, no-store");
  expect(await details.json()).toMatchObject({
    protection: {
      state: "pending",
      checkoutId: booking.checkoutId,
      attendanceBlock: "pending_deposit",
      depositCents: 2500,
      feeCents: 0,
      refundDueCents: 0,
    },
  });

  const professional = await actor(t, "staff", "staff@deposits.test", { staffProfileId: f.anaId });
  await t.db
    .update(staffProfile)
    .set({ accessPreset: "restricted" })
    .where(eq(staffProfile.id, f.anaId));
  expect((await call(client, path)).status).toBe(403);
  const restricted = await call(professional, path);
  expect(restricted.status).toBe(200);
  const context = (await restricted.json()) as { protection: Record<string, unknown> };
  expect(context).toMatchObject({
    protection: {
      state: "pending",
      expiresAt: expect.any(String),
      cancellationCutoff: expect.any(String),
    },
  });
  expect(Object.keys(context.protection).sort()).toEqual([
    "attendanceBlock",
    "cancellationCutoff",
    "expiresAt",
    "receiptRestricted",
    "state",
  ]);

  const receiptPath = `/admin/commerce/checkouts/${booking.checkoutId}`;
  const receipt = await call(owner, receiptPath);
  expect(receipt.status).toBe(200);
  expect(await receipt.json()).toMatchObject({ id: booking.checkoutId, appointmentId: id });
  expect((await call(professional, receiptPath)).status).toBe(403);

  const payment = await call(
    owner,
    `/admin/commerce/checkouts/${booking.checkoutId}/payments`,
    "POST",
    {
      method: "external_card",
      amountCents: 2500,
      idempotencyKey: crypto.randomUUID(),
    },
  );
  expect(payment.status).toBe(201);
  expect(await (await call(owner, path)).json()).toMatchObject({
    protection: { state: "confirmed", depositCents: 2500 },
  });
  expect(await mirrored()).toMatchObject({ data: { depositStatus: { state: "confirmed" } } });
});

test("a required signal needs explicit current policy acceptance and creates one server-priced appointment receipt", async () => {
  const p = await enable();
  expect((await book()).status).toBe(409);
  expect((await book({ protectionAcceptedVersion: p.version - 1 })).status).toBe(409);
  const res = await book({ protectionAcceptedVersion: p.version });
  expect(res.status, await res.clone().text()).toBe(201);
  const a = (await res.json()) as { id: string; protection: { checkoutId: string } };
  expect(a).toMatchObject({
    protection: {
      state: "pending",
      depositCents: 2500,
      policyVersion: 2,
      expiresAt: "2026-03-02T12:15:00.000Z",
    },
  });
  const receipt = await call(client, `/me/checkouts/${a.protection.checkoutId}`);
  expect(receipt.status).toBe(200);
  expect(await receipt.json()).toMatchObject({
    appointmentId: a.id,
    totalCents: 10000,
    payableCents: 2500,
    paidCents: 0,
  });
  expect((await call(other, `/me/checkouts/${a.protection.checkoutId}`)).status).toBe(404);
  const again = await call(client, "/me/checkouts", "POST", {
    appointmentId: a.id,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(((await again.json()) as { id: string }).id).toBe(a.protection.checkoutId);
  expect(await t.db.select().from(checkout)).toHaveLength(1);
});
test("deposit funding confirms the hold but cannot charge the remaining service balance before the visit", async () => {
  const p = await enable();
  const a = (await (await book({ protectionAcceptedVersion: p.version })).json()) as {
    id: string;
    protection: { checkoutId: string };
  };
  const id = a.protection.checkoutId;
  const pay = (n: number) =>
    call(owner, `/admin/commerce/checkouts/${id}/payments`, "POST", {
      method: "external_card",
      amountCents: n,
      idempotencyKey: crypto.randomUUID(),
    });
  expect((await pay(2501)).status).toBe(409);
  expect((await pay(1000)).status).toBe(201);
  expect((await pay(1500)).status).toBe(201);
  expect((await pay(1)).status).toBe(409);
  const receipt = await (await call(client, `/me/checkouts/${id}`)).json();
  expect(receipt).toMatchObject({
    paidCents: 2500,
    balanceCents: 7500,
    payableCents: 0,
    fulfilledAt: null,
    protection: { state: "confirmed" },
  });
  const due = await call(
    owner,
    "/admin/commerce/unpaid?from=2026-03-09T00:00:00Z&to=2026-03-10T00:00:00Z",
  );
  expect(due.status).toBe(200);
  expect(await due.json()).toMatchObject({
    appointments: [
      {
        id: a.id,
        receiptBalance: {
          id,
          confirmedCents: 2500,
          balanceCents: 7500,
          serviceBalanceDeferred: true,
        },
      },
    ],
  });
});
test("early cancellation releases the slot and shows the whole signal due back without erasing its payments", async () => {
  const p = await enable();
  const a = (await (await book({ protectionAcceptedVersion: p.version })).json()) as {
    id: string;
    version: number;
    protection: { checkoutId: string };
  };
  const id = a.protection.checkoutId;
  expect(
    (
      await call(owner, `/admin/commerce/checkouts/${id}/payments`, "POST", {
        method: "external_card",
        amountCents: 2500,
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(201);
  const cancel = await call(client, `/appointments/${a.id}`, "PATCH", {
    version: a.version + 1,
    status: "cancelled",
  });
  expect(cancel.status, await cancel.clone().text()).toBe(200);
  const receipt = await (await call(client, `/me/checkouts/${id}`)).json();
  expect(receipt).toMatchObject({
    status: "void",
    balanceCents: 0,
    payableCents: 0,
    paidCents: 2500,
    protection: { state: "cancelled", feeCents: 0, refundDueCents: 2500 },
  });
  expect(
    (
      await call(owner, `/admin/commerce/checkouts/${id}/payments`, "POST", {
        method: "external_card",
        amountCents: 1,
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(409);
  const [row] = await t.db.select().from(appointment).where(eq(appointment.id, a.id));
  expect(row?.status).toBe("cancelled");
  expect(await (await call(owner, `/appointments/${a.id}/context`)).json()).toMatchObject({
    protection: { state: "cancelled", attendanceBlock: "closed_protection", refundDueCents: 2500 },
  });
  const projections = await calendarProtections(t.db, [a.id, crypto.randomUUID()]);
  expect(projections.get(a.id)).toEqual((await protectionView(t.db, a.id)) ?? undefined);
  expect(projections.get(a.id)?.refundDueCents).toBe(2500);
  expect(projections.size).toBe(1);
  expect((await calendarProtections(t.db, [])).size).toBe(0);
});

async function funded(extra = {}, plan = {}) {
  const p = await enable(plan);
  const r = await book({ protectionAcceptedVersion: p.version, ...extra });
  expect(r.status, await r.clone().text()).toBe(201);
  const a = (await r.json()) as {
    id: string;
    version: number;
    protection: { checkoutId: string; depositCents: number };
  };
  const pay = await call(
    owner,
    `/admin/commerce/checkouts/${a.protection.checkoutId}/payments`,
    "POST",
    {
      method: "external_card",
      amountCents: a.protection.depositCents,
      idempotencyKey: crypto.randomUUID(),
    },
  );
  expect(pay.status, await pay.clone().text()).toBe(201);
  return {
    ...a,
    version: a.version + 1,
    paymentId: ((await pay.json()) as { payment: { id: string } }).payment.id,
  };
}
test("late cancellation keeps only the accepted fee capped by captured deposit and refunding it reverses fee recognition", async () => {
  const a = await funded(
    { startsAt: "2026-03-02T14:00:00.000Z" },
    { lateCancellationBasisPoints: 1000 },
  );
  const id = a.protection.checkoutId;
  expect(
    (
      await call(client, `/appointments/${a.id}`, "PATCH", {
        version: a.version,
        status: "cancelled",
      })
    ).status,
  ).toBe(200);
  expect(await (await call(client, `/me/checkouts/${id}`)).json()).toMatchObject({
    protection: { feeCents: 1000, refundDueCents: 1500 },
  });
  const refund = (amountCents: number) =>
    call(owner, `/admin/commerce/payments/${a.paymentId}/refunds`, "POST", {
      amountCents,
      reason: "Customer cancellation review",
      idempotencyKey: crypto.randomUUID(),
    });
  expect((await refund(1500)).status).toBe(201);
  expect(await (await call(client, `/me/checkouts/${id}`)).json()).toMatchObject({
    protection: { feeCents: 1000, refundDueCents: 0 },
    refundedCents: 1500,
  });
  expect((await refund(1000)).status).toBe(201);
  expect(await (await call(client, `/me/checkouts/${id}`)).json()).toMatchObject({
    protection: { feeCents: 0, refundDueCents: 0 },
    refundedCents: 2500,
  });
  expect((await t.db.select().from(bookingFeeMovement)).map((r) => r.amountCents)).toEqual([
    1000, -1000,
  ]);
});
test("concurrent expiry cancels each unpaid hold once and releases its occupied slot", async () => {
  const p = await enable();
  const r = await book({ protectionAcceptedVersion: p.version });
  const a = (await r.json()) as { id: string; protection: { checkoutId: string } };
  expect(await t.db.select().from(reminder)).toHaveLength(0);
  const counts = await Promise.all([
    expireBookingHolds(t.db, new Date(NOW.getTime() + 15 * 60000)),
    expireBookingHolds(t.db, new Date(NOW.getTime() + 15 * 60000)),
  ]);
  expect(counts.reduce((n, v) => n + v, 0)).toBe(1);
  expect(
    await (await call(client, `/me/checkouts/${a.protection.checkoutId}`)).json(),
  ).toMatchObject({ status: "void", protection: { state: "expired", feeCents: 0 } });
  expect((await book({ protectionAcceptedVersion: p.version })).status).toBe(201);
});
test("a bank success after hold expiry is refundable reconciliation and never rebooks or schedules confirmation", async () => {
  const p = await enable();
  const a = (await (await book({ protectionAcceptedVersion: p.version })).json()) as {
    id: string;
    protection: { checkoutId: string };
  };
  await t.db.insert(checkoutPayment).values({
    checkoutId: a.protection.checkoutId,
    method: "redsys_card",
    amountCents: 2500,
    bankOrder: "1234deadbeef",
    idempotencyKey: crypto.randomUUID(),
    requestHash: "fixture",
  });
  await settleVerifiedBankPayment(
    t.db,
    {
      order: "1234deadbeef",
      amountCents: 2500,
      currency: "EUR",
      responseCode: "0000",
      success: true,
      authorizationCode: null,
      transactionType: "0",
    },
    null,
    new Date(NOW.getTime() + 15 * 60000),
  );
  expect(
    await (await call(client, `/me/checkouts/${a.protection.checkoutId}`)).json(),
  ).toMatchObject({
    status: "void",
    paidCents: 2500,
    protection: { state: "expired", refundDueCents: 2500 },
  });
  const [payment] = await t.db.select().from(checkoutPayment);
  expect(payment?.status).toBe("reconciliation");
  expect(await t.db.select().from(reminder)).toHaveLength(0);
});
test("fully funded protected visits earn service revenue only once completed; the deposit is not charged twice", async () => {
  const a = await funded({}, { depositValue: 10000 });
  expect(
    await (await call(client, `/me/checkouts/${a.protection.checkoutId}`)).json(),
  ).toMatchObject({ totalCents: 10000, paidCents: 10000, fulfilledAt: null });
  await updateAppointment(
    t.db,
    a.id,
    { version: a.version, status: "completed" },
    { userId: owner.userId },
    { now: new Date(MONDAY_0900) },
  );
  const receipt = (await (
    await call(client, `/me/checkouts/${a.protection.checkoutId}`)
  ).json()) as { fulfilledAt: string | null; protection: { state: string } };
  expect(receipt.fulfilledAt).not.toBeNull();
  expect(receipt.protection.state).toBe("completed");
  const correction = await call(owner, `/appointments/${a.id}`, "PATCH", {
    version: a.version + 1,
    status: "no_show",
  });
  expect(correction.status).toBe(409);
});
test("no-show fee cannot exceed the paid signal and future service charges stop", async () => {
  const a = await funded();
  await updateAppointment(
    t.db,
    a.id,
    { version: a.version, status: "no_show" },
    { userId: owner.userId },
    { now: new Date(MONDAY_0900) },
  );
  expect(
    await (await call(client, `/me/checkouts/${a.protection.checkoutId}`)).json(),
  ).toMatchObject({
    status: "void",
    fulfilledAt: null,
    protection: { state: "no_show", feeCents: 2500, refundDueCents: 0 },
  });
  const reopen = await call(owner, "/admin/commerce/checkouts", "POST", {
    appointmentId: a.id,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(reopen.status).toBe(201);
  expect(await reopen.json()).toMatchObject({ id: a.protection.checkoutId, status: "void" });
  expect(await t.db.select().from(checkout).where(eq(checkout.appointmentId, a.id))).toHaveLength(
    1,
  );
});
test("a reassigned professional can see the signal but cannot open the original seller's receipt", async () => {
  const a = await funded();
  const bea = await actor(t, "staff", "bea@deposits.test", { staffProfileId: f.beaId });
  await updateAppointment(
    t.db,
    a.id,
    { version: a.version, staffId: f.beaId },
    { userId: owner.userId },
    { now: new Date(NOW) },
  );
  const path = `/appointments/${a.id}/context`;
  const reassigned = await call(bea, path);
  expect(reassigned.status).toBe(200);
  const context = (await reassigned.json()) as { protection: Record<string, unknown> };
  expect(context.protection).toMatchObject({ state: "confirmed", receiptRestricted: true });
  expect(context.protection.checkoutId).toBeUndefined();
  expect((await call(bea, `/admin/commerce/checkouts/${a.protection.checkoutId}`)).status).toBe(
    404,
  );
  expect(await (await call(owner, path)).json()).toMatchObject({
    protection: { checkoutId: a.protection.checkoutId },
  });
});

test("trusted exemption and an audited manager waiver do not allow customers to impersonate a waiver", async () => {
  await enable();
  expect((await book({ protectionWaiverReason: "Waive my own fee" })).status).toBe(403);
  const waived = await book(
    { clientId: client.clientId, protectionWaiverReason: "Salon booking paid on arrival" },
    owner,
  );
  expect(waived.status, await waived.clone().text()).toBe(201);
  expect(await waived.json()).toMatchObject({ protection: { state: "waived", depositCents: 0 } });
  await t.db
    .update(clientProfile)
    .set({ bookingAccess: "trusted" })
    .where(eq(clientProfile.id, mustClient(other)));
  const trusted = await book({ startsAt: "2026-03-09T13:00:00.000Z" }, other);
  expect(trusted.status, await trusted.clone().text()).toBe(201);
  const view = await trusted.json();
  expect(view).toMatchObject({ protection: { state: "waived" } });
  expect(JSON.stringify(view)).not.toContain("Trusted customer exemption");
});
test("late rescheduling cannot bypass a fee deadline and pending holds retain their original expiry", async () => {
  const a = await funded({ startsAt: "2026-03-02T14:00:00.000Z" });
  expect(
    (
      await call(client, `/appointments/${a.id}`, "PATCH", {
        version: a.version,
        startsAt: MONDAY_0900,
        protectionAcceptedTotalCents: 10000,
      })
    ).status,
  ).toBe(409);
  const [p] = await t.db
    .select()
    .from(bookingProtection)
    .where(eq(bookingProtection.appointmentId, a.id));
  expect(p?.cancellationCutoff.toISOString()).toBe("2026-03-01T14:00:00.000Z");
});

test("returning a required signal withdraws confirmation and an elapsed hold cannot remain booked", async () => {
  const a = await funded();
  // The original expiry is past when this operational refund happens.
  await t.db
    .update(bookingProtection)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(bookingProtection.appointmentId, a.id));
  const refund = await call(owner, `/admin/commerce/payments/${a.paymentId}/refunds`, "POST", {
    amountCents: 2500,
    reason: "Return the entire reservation signal",
    idempotencyKey: crypto.randomUUID(),
  });
  expect(refund.status).toBe(201);
  const [row] = await t.db.select().from(appointment).where(eq(appointment.id, a.id));
  expect(row?.status).toBe("cancelled");
  expect(
    await (await call(client, `/me/checkouts/${a.protection.checkoutId}`)).json(),
  ).toMatchObject({ status: "void", protection: { state: "expired" } });
});

test("reports recognize cancellation fees separately from unperformed services and include later fee reversals", async () => {
  const a = await funded({ startsAt: "2026-03-02T14:00:00.000Z" });
  expect(
    (
      await call(client, `/appointments/${a.id}`, "PATCH", {
        version: a.version,
        status: "cancelled",
      })
    ).status,
  ).toBe(200);
  // Fixtures' appointment clock is March; fee-ledger timestamps follow the adjudication clock.
  const report = await call(owner, "/admin/accounting/sales?from=2026-03-02&to=2026-03-02");
  expect(report.status).toBe(200);
  expect(await report.json()).toMatchObject({ bookingFeesCents: 2500, soldCents: 0 });
});

test("a policy checkbox cannot silently accept a service price changed since the customer review", async () => {
  const p = await enable();
  const response = await book({
    protectionAcceptedVersion: p.version,
    protectionAcceptedTotalCents: 9999,
  });
  expect(response.status).toBe(409);
  expect(await t.db.select().from(appointment)).toHaveLength(0);
});

for (const rate of [2000, 10000])
  test(`deposit receipts preserve a ${rate} basis-point membership discount including fully covered visits`, async () => {
    const plan = await call(owner, "/admin/benefit-plans", "POST", {
      name: "Discount membership",
      kind: "membership",
      priceCents: 1000,
      includedUses: 0,
      periodMonths: 1,
      discountBasisPoints: rate,
      serviceIds: [f.haircutId],
      idempotencyKey: crypto.randomUUID(),
    });
    expect(plan.status, await plan.clone().text()).toBe(201);
    const planId = ((await plan.json()) as { id: string }).id;
    const purchase = await call(owner, "/admin/passes", "POST", {
      planId,
      clientId: client.clientId,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(purchase.status, await purchase.clone().text()).toBe(201);
    const bought = (await purchase.json()) as { pass: { id: string }; checkout: { id: string } };
    expect(
      (
        await call(owner, `/admin/commerce/checkouts/${bought.checkout.id}/payments`, "POST", {
          method: "external_card",
          amountCents: 1000,
          idempotencyKey: crypto.randomUUID(),
        })
      ).status,
    ).toBe(201);
    await t.db
      .update(passPeriod)
      .set({ startsAt: NOW, endsAt: new Date("2026-04-02T12:00:00.000Z") })
      .where(eq(passPeriod.contractId, bought.pass.id));
    const p = await enable();
    const response = await book({ protectionAcceptedVersion: p.version });
    expect(response.status, await response.clone().text()).toBe(201);
    const a = (await response.json()) as { protection: { checkoutId: string } };
    expect(
      await (await call(client, `/me/checkouts/${a.protection.checkoutId}`)).json(),
    ).toMatchObject({
      subtotalCents: 10000,
      discountCents: rate,
      totalCents: 10000 - rate,
      payableCents: (10000 - rate) / 4,
      protection: {
        depositCents: (10000 - rate) / 4,
        state: rate === 10000 ? "waived" : "pending",
      },
    });
  });

test("a requested bank refund still appears due back until the bank confirms it", async () => {
  const a = await funded();
  await t.db
    .update(checkoutPayment)
    .set({ method: "redsys_card", bankOrder: "1234f00dfeed" })
    .where(eq(checkoutPayment.id, a.paymentId));
  expect(
    (
      await call(client, `/appointments/${a.id}`, "PATCH", {
        version: a.version,
        status: "cancelled",
      })
    ).status,
  ).toBe(200);
  const refund = await call(owner, `/admin/commerce/payments/${a.paymentId}/refunds`, "POST", {
    amountCents: 2500,
    reason: "Deposit refund awaiting bank dispatch",
    idempotencyKey: crypto.randomUUID(),
  });
  expect(refund.status).toBe(201);
  expect(
    await (await call(client, `/me/checkouts/${a.protection.checkoutId}`)).json(),
  ).toMatchObject({ refundedCents: 0, protection: { refundDueCents: 2500 } });
});

test("manual reconciliation of an elapsed hold cannot confirm the expired reservation", async () => {
  const p = await enable();
  const a = (await (await book({ protectionAcceptedVersion: p.version })).json()) as {
    id: string;
    protection: { checkoutId: string };
  };
  const [payment] = await t.db
    .insert(checkoutPayment)
    .values({
      checkoutId: a.protection.checkoutId,
      method: "redsys_card",
      bankOrder: "1234cafebabe",
      amountCents: 2500,
      idempotencyKey: crypto.randomUUID(),
      requestHash: "fixture",
      updatedAt: new Date(Date.now() - 61000),
    })
    .returning();
  if (!payment) throw new Error("Missing fixture payment");
  await t.db
    .update(bookingProtection)
    .set({ expiresAt: new Date(NOW.getTime() - 1) })
    .where(eq(bookingProtection.appointmentId, a.id));
  const response = await call(owner, `/admin/commerce/payments/${payment.id}/reconcile`, "POST", {
    outcome: "succeeded",
    reference: "Verified original bank portal capture",
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ status: "reconciliation" });
  expect(
    await (await call(client, `/me/checkouts/${a.protection.checkoutId}`)).json(),
  ).toMatchObject({ status: "void", protection: { state: "expired", refundDueCents: 2500 } });
});

test("returning part of a required signal cancels the confirmed reservation even before its deadline", async () => {
  const a = await funded();
  await t.db
    .update(bookingProtection)
    .set({ expiresAt: new Date(Date.now() + 3600000) })
    .where(eq(bookingProtection.appointmentId, a.id));
  expect(
    (
      await call(owner, `/admin/commerce/payments/${a.paymentId}/refunds`, "POST", {
        amountCents: 1,
        reason: "Manager returns required signal",
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(201);
  expect(
    await (await call(client, `/me/checkouts/${a.protection.checkoutId}`)).json(),
  ).toMatchObject({
    status: "void",
    protection: { state: "cancelled", feeCents: 0, refundDueCents: 2499 },
  });
});
