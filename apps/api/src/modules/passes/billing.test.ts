import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { passContractSchema, passPurchaseResponseSchema } from "@sob/contracts";
import { passContract, passPeriod, service } from "@sob/db";
import { eq, sql } from "drizzle-orm";
import {
  type Actor,
  actor,
  type Fixtures,
  json,
  seedFixtures,
  setupApiTest,
} from "../../../test/helpers";
import { RedsysGateway, redsysSignature } from "../../payments/redsys";
import type { PaymentGateway } from "../../payments/types";
import { runMembershipBilling } from "./billing";

const secret = "sq7HjrUOBfKmC576ILgskD5srU870gJ7";
const encryptionKey = Buffer.alloc(32, 7).toString("base64");
const reference = "120c14ed9f7264383434fc1154559f1e2bcc2b1c";
const consentVersion = "sob.membership-recurring.v1";
let t: Awaited<ReturnType<typeof setupApiTest>>;
let owner: Actor;
let client: Actor;
let f: Fixtures;
let gateway: PaymentGateway;
let calls: { order: string; amountCents: number }[];
let outcome: "success" | "declined" | "unknown";
let beforeResponse: (() => Promise<void>) | undefined;
const key = () => crypto.randomUUID();
const call = (who: Actor, path: string, method = "GET", body?: unknown) =>
  json(t.app, path, method, body, who.cookie);
function signed(order: string, amountCents: number, extra: Record<string, unknown> = {}) {
  const payload = {
    Ds_Order: order,
    Ds_Amount: String(amountCents),
    Ds_Currency: "978",
    Ds_MerchantCode: "999008881",
    Ds_Terminal: "1",
    Ds_Response: "0000",
    Ds_TransactionType: "0",
    ...extra,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return {
    Ds_SignatureVersion: "HMAC_SHA512_V2",
    Ds_MerchantParameters: encoded,
    Ds_Signature: redsysSignature(secret, order, encoded),
  };
}
async function plan() {
  const response = await call(owner, "/admin/benefit-plans", "POST", {
    name: "Monthly visits",
    kind: "membership",
    priceCents: 1000,
    includedUses: 2,
    periodMonths: 1,
    serviceIds: [f.haircutId],
    idempotencyKey: key(),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; version: number };
}
async function enrolled(withReference = true) {
  const p = await plan();
  const response = await call(client, "/me/passes", "POST", {
    planId: p.id,
    planVersion: p.version,
    renewalMode: "automatic",
    acceptRecurring: true,
    consentVersion,
    idempotencyKey: key(),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  const purchase = passPurchaseResponseSchema.parse(await response.json());
  const started = await call(client, `/me/checkouts/${purchase.checkout.id}/payments`, "POST", {
    method: "redsys_card",
    amountCents: 1000,
    idempotencyKey: key(),
  });
  expect(started.status, await started.clone().text()).toBe(201);
  const payment = (await started.json()) as {
    payment: { id: string; order: string };
    form: { fields: { Ds_MerchantParameters: string } };
  };
  expect(
    JSON.parse(Buffer.from(payment.form.fields.Ds_MerchantParameters, "base64url").toString()),
  ).toMatchObject({
    DS_MERCHANT_IDENTIFIER: "REQUIRED",
    DS_MERCHANT_COF_INI: "S",
    DS_MERCHANT_COF_TYPE: "R",
  });
  const extra = withReference
    ? {
        Ds_Merchant_Identifier: reference,
        Ds_Merchant_Cof_Txnid: "2006031152000",
        Ds_ExpiryDate: "3412",
        Ds_Card_Last4: "0003",
      }
    : {};
  const bank = await t.app.request("/payments/redsys/notify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(signed(payment.payment.order, 1000, extra)),
  });
  expect(bank.status, await bank.clone().text()).toBe(200);
  return purchase;
}
async function get(id: string) {
  const response = await call(client, `/me/passes/${id}`);
  expect(response.status).toBe(200);
  return passContractSchema.parse(await response.json());
}
async function due(purchase: Awaited<ReturnType<typeof enrolled>>) {
  const now = new Date();
  const anchor = new Date(
    Temporal.Instant.from(now.toISOString())
      .toZonedDateTimeISO("America/Argentina/Buenos_Aires")
      .subtract({ months: 1 }).epochMilliseconds,
  );
  await t.db
    .update(passContract)
    .set({ anchorAt: anchor })
    .where(eq(passContract.id, purchase.pass.id));
  await t.db
    .update(passPeriod)
    .set({ startsAt: anchor, endsAt: new Date(now.getTime() - 1) })
    .where(eq(passPeriod.id, purchase.period.id));
  return now;
}
const run = (now = new Date()) =>
  runMembershipBilling({ db: t.db, config: t.config, gateway, now: () => now });
beforeAll(async () => {
  const bank = new RedsysGateway({
    secret,
    merchantCode: "999008881",
    terminal: "001",
    environment: "test",
    publicURL: "http://localhost:3000",
    recurringEnabled: true,
  });
  gateway = {
    provider: "redsys",
    environment: "test",
    supportsRecurring: true,
    checkout: (i) => bank.checkout(i),
    verify: (fields, type) => bank.verify(fields, type),
    refund: async () => {
      throw new Error("Unexpected refund transport");
    },
    chargeRecurring: async (input) => {
      calls.push({ order: input.order, amountCents: input.amountCents });
      await beforeResponse?.();
      if (outcome === "unknown") throw new Error("Lost bank response");
      return bank.verify(
        signed(input.order, input.amountCents, {
          Ds_Response: outcome === "declined" ? "0190" : "0000",
        }),
      );
    },
  };
  t = await setupApiTest({
    dbSuffix: "recurring_billing",
    env: {
      PAYMENT_PROVIDER: "redsys",
      REDSYS_MERCHANT_CODE: "999008881",
      REDSYS_TERMINAL: "001",
      REDSYS_SECRET_KEY: secret,
      REDSYS_RECURRING_ENABLED: "true",
      PAYMENT_TOKEN_ENCRYPTION_KEY: encryptionKey,
    },
    deps: { paymentGateway: gateway },
  });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  f = await seedFixtures(t.db);
  await t.db.update(service).set({ currency: "EUR" });
  [owner, client] = await Promise.all([
    actor(t, "owner", "billing-owner@example.com"),
    actor(t, "client", "billing-client@example.com"),
  ]);
  calls = [];
  outcome = "success";
  beforeResponse = undefined;
  t.config.payments.tokenEncryptionKey = encryptionKey;
});
test("recurring enrollment binds client consent to current plan terms and encrypts its authenticated bank reference", async () => {
  const purchase = await enrolled();
  const current = await get(purchase.pass.id);
  expect(current).toMatchObject({ renewalMode: "automatic", autoPayReady: true });
  expect(JSON.stringify(current)).not.toContain(reference);
  const [stored] = await t.db.execute<{ encrypted_payload: string }>(
    sql`select encrypted_payload from pass_mandate where contract_id=${purchase.pass.id}`,
  );
  expect(stored?.encrypted_payload).toMatch(/^v1\./);
  expect(stored?.encrypted_payload).not.toContain(reference);
  const audit = await t.db.execute(sql`select metadata from audit_log`);
  expect(JSON.stringify(audit)).not.toContain(reference);
  const p = await plan();
  expect(
    (
      await call(owner, "/admin/passes", "POST", {
        planId: p.id,
        planVersion: p.version,
        clientId: client.clientId,
        renewalMode: "automatic",
        acceptRecurring: true,
        consentVersion,
        idempotencyKey: key(),
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await call(client, "/me/passes", "POST", {
        planId: p.id,
        renewalMode: "automatic",
        acceptRecurring: true,
        consentVersion,
        idempotencyKey: key(),
      })
    ).status,
  ).toBe(400);
});
test("a confirmed payment without reference metadata preserves paid benefits and cannot auto-charge", async () => {
  const purchase = await enrolled(false);
  expect(await get(purchase.pass.id)).toMatchObject({ status: "active", autoPayReady: false });
  await run(await due(purchase));
  expect(calls).toHaveLength(0);
});
test("concurrent billing claims fund one period at the original agreed price and never duplicate it", async () => {
  const purchase = await enrolled();
  await call(owner, `/admin/benefit-plans/${purchase.pass.planId}`, "PATCH", {
    version: 1,
    priceCents: 2000,
  });
  const now = await due(purchase);
  await Promise.all([run(now), run(now)]);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.amountCents).toBe(1000);
  const current = await get(purchase.pass.id);
  expect(current.periods).toHaveLength(2);
  expect(current.periods[0]).toMatchObject({
    status: "active",
    availableUses: 2,
    priceCents: 1000,
  });
  await run(now);
  expect(calls).toHaveLength(1);
});
test("unknown outcomes stay pending and reserve the same bank order without automatic retry", async () => {
  const purchase = await enrolled();
  outcome = "unknown";
  const now = await due(purchase);
  await run(now);
  await run(now);
  expect(calls).toHaveLength(1);
  const [payment] = await t.db.execute<{ id: string; status: string; bank_order: string }>(
    sql`select id,status,bank_order from checkout_payment where merchant_initiated=true`,
  );
  expect(payment?.status).toBe("pending");
  expect(payment?.bank_order).toBe(calls[0]?.order);
  const current = await get(purchase.pass.id);
  expect(current.periods[0]).toMatchObject({ status: "pending", availableUses: 0 });
  if (!payment) throw new Error("Missing pending payment");
  await t.db.execute(
    sql`update checkout_payment set updated_at=now()-interval '2 minutes' where id=${payment.id}`,
  );
  const reconciled = await call(owner, `/admin/commerce/payments/${payment.id}/reconcile`, "POST", {
    outcome: "succeeded",
    reference: "BANK-PORTAL-CAPTURE-CONFIRMED",
  });
  expect(reconciled.status).toBe(200);
  expect((await get(purchase.pass.id)).periods[0]).toMatchObject({
    status: "active",
    availableUses: 2,
  });
});
test("definitive declines require manual payment and do not enter an automatic retry loop", async () => {
  const purchase = await enrolled();
  outcome = "declined";
  const now = await due(purchase);
  await run(now);
  await run(now);
  expect(calls).toHaveLength(1);
  expect((await get(purchase.pass.id)).periods[0]).toMatchObject({
    status: "pending",
    availableUses: 0,
  });
  const [payment] = await t.db.execute<{ status: string }>(
    sql`select status from checkout_payment where merchant_initiated=true`,
  );
  expect(payment?.status).toBe("failed");
  expect((await get(purchase.pass.id)).autoPayReady).toBe(false);
});
test("an already opened manual renewal invoice prevents a second automatic invoice or hidden charge", async () => {
  const purchase = await enrolled();
  const response = await call(client, `/me/passes/${purchase.pass.id}/renew`, "POST", {
    idempotencyKey: key(),
  });
  expect(response.status).toBe(201);
  await run(await due(purchase));
  expect(calls).toHaveLength(0);
  expect((await get(purchase.pass.id)).periods).toHaveLength(2);
});
test("cancellation stops future charges even while one already dispatched bank operation resolves", async () => {
  const purchase = await enrolled();
  const now = await due(purchase);
  let reached: () => void = () => {};
  let release: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const finish = new Promise<void>((resolve) => {
    release = resolve;
  });
  beforeResponse = async () => {
    reached();
    await finish;
  };
  const processing = run(now);
  await started;
  const current = await get(purchase.pass.id);
  try {
    const cancelled = await call(client, `/me/passes/${purchase.pass.id}/cancel`, "POST", {
      version: current.version,
      reason: "Stop future bank renewals",
    });
    expect(cancelled.status, await cancelled.clone().text()).toBe(200);
  } finally {
    release();
    await processing;
  }
  const final = await get(purchase.pass.id);
  expect(final).toMatchObject({ cancelAtPeriodEnd: true, autoPayReady: false });
  expect(final.periods[0]?.availableUses).toBe(2);
  await run(new Date(now.getTime() + 70 * 86400000));
  expect(calls).toHaveLength(1);
});
test("an unavailable vault key or changed merchant binding stops billing before transport", async () => {
  const purchase = await enrolled();
  const now = await due(purchase);
  t.config.payments.tokenEncryptionKey = Buffer.alloc(32, 8).toString("base64");
  await run(now);
  expect(calls).toHaveLength(0);
  expect(await get(purchase.pass.id)).toMatchObject({ autoPayReady: false });
  expect((await get(purchase.pass.id)).periods).toHaveLength(1);
});
test("returning an entire paid membership period revokes future billing without recreating refunded visits", async () => {
  const purchase = await enrolled();
  const now = await due(purchase);
  await run(now);
  const current = await get(purchase.pass.id);
  const latest = current.periods[0];
  if (!latest) throw new Error("Missing renewal period");
  const [payment] = await t.db.execute<{ id: string }>(
    sql`update checkout_payment set method='external_card' where checkout_id=${latest.checkoutId} returning id`,
  );
  if (!payment) throw new Error("Missing paid renewal");
  const returned = await call(owner, `/admin/commerce/payments/${payment.id}/refunds`, "POST", {
    amountCents: 1000,
    reason: "End this paid membership period",
    idempotencyKey: key(),
  });
  expect(returned.status, await returned.clone().text()).toBe(201);
  expect(await get(purchase.pass.id)).toMatchObject({
    cancelAtPeriodEnd: true,
    autoPayReady: false,
  });
  const [mandate] = await t.db.execute<{ encrypted_payload: string | null }>(
    sql`select encrypted_payload from pass_mandate where contract_id=${purchase.pass.id}`,
  );
  expect(mandate?.encrypted_payload).toBeNull();
  await run(new Date(now.getTime() + 70 * 86400000));
  expect(calls).toHaveLength(1);
});
test("billing refuses terms changed without a matching new customer agreement", async () => {
  const purchase = await enrolled();
  const now = await due(purchase);
  await t.db
    .update(passContract)
    .set({ priceCents: 2000 })
    .where(eq(passContract.id, purchase.pass.id));
  await run(now);
  expect(calls).toHaveLength(0);
  expect((await get(purchase.pass.id)).autoPayReady).toBe(false);
});
test("blocked booking profiles stop future billing instead of charging for benefits they cannot book", async () => {
  const purchase = await enrolled();
  const now = await due(purchase);
  const response = await call(owner, `/admin/clients/${client.clientId}/controls`, "PATCH", {
    version: 1,
    bookingAccess: "blocked",
    reason: "Profile requires review",
  });
  expect(response.status).toBe(200);
  await run(now);
  expect(calls).toHaveLength(0);
  expect((await get(purchase.pass.id)).autoPayReady).toBe(false);
});
test("changing the payer's login role stops automatic billing until customer access is reviewed", async () => {
  const purchase = await enrolled();
  const now = await due(purchase);
  await t.db.execute(sql`update "user" set role='staff' where id=${client.userId}`);
  await run(now);
  expect(calls).toHaveLength(0);
  const [row] = await t.db
    .select({ ready: passContract.autoPayReady })
    .from(passContract)
    .where(eq(passContract.id, purchase.pass.id));
  expect(row?.ready).toBe(false);
});
test("cancelling an unpaid renewal invoice also stops future automatic renewal and preserves already paid visits", async () => {
  const purchase = await enrolled();
  const response = await call(client, `/me/passes/${purchase.pass.id}/renew`, "POST", {
    idempotencyKey: key(),
  });
  expect(response.status).toBe(201);
  const renewal = passPurchaseResponseSchema.parse(await response.json());
  const cancelled = await call(client, `/me/checkouts/${renewal.checkout.id}/void`, "POST", {});
  expect(cancelled.status).toBe(200);
  expect(await cancelled.json()).toMatchObject({ balanceCents: 0 });
  const current = await get(purchase.pass.id);
  expect(current).toMatchObject({ cancelAtPeriodEnd: true, autoPayReady: false });
  expect(current.periods.find((period) => period.index === 0)?.availableUses).toBe(2);
  await run(await due(purchase));
  expect(calls).toHaveLength(0);
});
test("discontinued eligible services pause automatic billing until the salon reviews the plan", async () => {
  const purchase = await enrolled();
  const now = await due(purchase);
  await t.db.update(service).set({ active: false }).where(eq(service.id, f.haircutId));
  await run(now);
  expect(calls).toHaveLength(0);
  expect((await get(purchase.pass.id)).autoPayReady).toBe(false);
});
test("stopping renewal is idempotent even when a background settlement advanced the displayed revision", async () => {
  const purchase = await enrolled();
  const displayed = await get(purchase.pass.id);
  const now = await due(purchase);
  await run(now);
  expect((await get(purchase.pass.id)).version).toBeGreaterThan(displayed.version);
  const body = { version: displayed.version, reason: "Stop future scheduled renewals" };
  const response = await call(client, `/me/passes/${purchase.pass.id}/cancel`, "POST", body);
  expect(response.status, await response.clone().text()).toBe(200);
  const stopped = passContractSchema.parse(await response.json());
  expect(stopped).toMatchObject({ cancelAtPeriodEnd: true, autoPayReady: false });
  const repeated = await call(client, `/me/passes/${purchase.pass.id}/cancel`, "POST", body);
  expect(repeated.status).toBe(200);
  expect(passContractSchema.parse(await repeated.json()).version).toBe(stopped.version);
  await run(new Date(now.getTime() + 70 * 86400000));
  expect(calls).toHaveLength(1);
});
