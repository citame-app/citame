import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { sql } from "drizzle-orm";
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

let t: Awaited<ReturnType<typeof setupApiTest>>;
let fixtures: Fixtures;
let owner: Actor;
let client: Actor;
let other: Actor;
let refundOutcome: "success" | "unknown" | "failed";
let dispatches = 0;
const secret = "sq7HjrUOBfKmC576ILgskD5srU870gJ7";
const key = () => crypto.randomUUID();
const call = (who: Actor, path: string, method = "GET", body?: unknown) =>
  json(t.app, path, method, body, who.cookie);
type Card = {
  id: string;
  balanceCents: number;
  reservedCents: number;
  availableCents: number;
  status: string;
  version: number;
};
type Purchase = { card: Card; checkout: { id: string; totalCents: number } };
async function buy(amountCents = 1000, extra: Record<string, unknown> = {}, who = owner) {
  const response = await call(who, `${who === client ? "/me" : "/admin"}/gift-cards`, "POST", {
    amountCents,
    idempotencyKey: key(),
    ...extra,
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as Purchase;
}
async function pay(
  sale: string,
  method: string,
  amountCents: number,
  code?: string,
  idempotencyKey = key(),
) {
  return call(owner, `/admin/commerce/checkouts/${sale}/payments`, "POST", {
    method,
    amountCents,
    idempotencyKey,
    ...(code ? { giftCardCode: code } : {}),
  });
}
async function reveal(id: string, who = owner) {
  const response = await call(
    who,
    `${who === client ? "/me" : "/admin"}/gift-cards/${id}/code`,
    "POST",
    {},
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { code: string }).code;
}
const card = async (id: string) =>
  (await (await call(owner, `/admin/gift-cards/${id}`)).json()) as Card;
async function active(amount = 1000) {
  const purchase = await buy(amount);
  const response = await pay(purchase.checkout.id, "external_card", amount);
  expect(response.status).toBe(201);
  return {
    ...purchase,
    payment: ((await response.json()) as { payment: { id: string } }).payment,
    code: await reveal(purchase.card.id),
  };
}
async function sale(amount = 1000) {
  const response = await call(owner, "/admin/commerce/checkouts", "POST", {
    lines: [{ kind: "custom", description: "Service", quantity: 1, unitAmountCents: amount }],
    idempotencyKey: key(),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string };
}
async function refund(paymentId: string, amountCents: number, idempotencyKey = key()) {
  return call(owner, `/admin/commerce/payments/${paymentId}/refunds`, "POST", {
    amountCents,
    reason: "Customer refund",
    idempotencyKey,
  });
}
async function notify(order: string, amountCents: number) {
  const encoded = Buffer.from(
    JSON.stringify({
      Ds_Order: order,
      Ds_Amount: String(amountCents),
      Ds_Currency: "978",
      Ds_MerchantCode: "999008881",
      Ds_Terminal: "1",
      Ds_Response: "0000",
      Ds_TransactionType: "0",
    }),
  ).toString("base64url");
  return t.app.request("/payments/redsys/notify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      Ds_MerchantParameters: encoded,
      Ds_SignatureVersion: "HMAC_SHA512_V2",
      Ds_Signature: redsysSignature(secret, order, encoded),
    }),
  });
}
beforeAll(async () => {
  const bank = new RedsysGateway({
    secret,
    merchantCode: "999008881",
    terminal: "001",
    environment: "test",
    publicURL: "http://localhost:3000",
  });
  const gateway: PaymentGateway = {
    provider: "redsys",
    environment: "test",
    checkout: (input) => bank.checkout(input),
    verify: (fields, type) => bank.verify(fields, type),
    refund: async (input) => {
      dispatches++;
      if (refundOutcome === "unknown") throw new Error("Lost bank response");
      return {
        order: input.order,
        amountCents: input.amountCents,
        currency: "EUR",
        transactionType: "3",
        responseCode: refundOutcome === "success" ? "0900" : "0190",
        success: refundOutcome === "success",
        authorizationCode: null,
      };
    },
  };
  t = await setupApiTest({
    dbSuffix: "gift_cards",
    env: {
      PAYMENT_PROVIDER: "redsys",
      REDSYS_MERCHANT_CODE: "999008881",
      REDSYS_TERMINAL: "001",
      REDSYS_SECRET_KEY: secret,
    },
    deps: { paymentGateway: gateway },
  });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  fixtures = await seedFixtures(t.db);
  [owner, client, other] = await Promise.all([
    actor(t, "owner", "gift-owner@example.com"),
    actor(t, "client", "gift-client@example.com"),
    actor(t, "client", "gift-other@example.com"),
  ]);
  refundOutcome = "success";
  dispatches = 0;
});

test("purchase is idempotent, pending value cannot be used or revealed and activation stores no plaintext code", async () => {
  const replayKey = key();
  const purchase = await buy(1000, { idempotencyKey: replayKey });
  expect((await buy(1000, { idempotencyKey: replayKey })).card.id).toBe(purchase.card.id);
  expect(
    (
      await call(owner, "/admin/gift-cards", "POST", {
        amountCents: 2000,
        idempotencyKey: replayKey,
      })
    ).status,
  ).toBe(409);
  expect(purchase.card).toMatchObject({ status: "pending", balanceCents: 0 });
  expect((await call(owner, `/admin/gift-cards/${purchase.card.id}/code`, "POST", {})).status).toBe(
    409,
  );
  expect((await pay(purchase.checkout.id, "external_card", 1000)).status).toBe(201);
  const code = await reveal(purchase.card.id);
  expect(code).toMatch(/^SOB-/);
  expect(await card(purchase.card.id)).toMatchObject({
    status: "active",
    balanceCents: 1000,
    availableCents: 1000,
  });
  const [stored] = await t.db.execute<Record<string, unknown>>(
    sql`select * from gift_card where id = ${purchase.card.id}`,
  );
  expect(stored?.code_hash).not.toBe(code);
  expect(JSON.stringify(stored)).not.toContain(code);
  const audit = await t.db.execute<Record<string, unknown>>(sql`select metadata from audit_log`);
  expect(JSON.stringify(audit)).not.toContain(code);
});
test("competing redemptions cannot overspend and replaying one tender cannot debit twice", async () => {
  const gift = await active();
  const [a, b] = await Promise.all([sale(), sale()]);
  const requestKey = key();
  const outcomes = await Promise.all([
    pay(a.id, "gift_card", 1000, gift.code, requestKey),
    pay(b.id, "gift_card", 1000, gift.code),
  ]);
  expect(outcomes.map((response) => response.status).sort()).toEqual([201, 409]);
  const winner = outcomes[0]?.status === 201 ? a : b;
  expect(await card(gift.card.id)).toMatchObject({ balanceCents: 0, availableCents: 0 });
  if (winner === a)
    expect((await pay(a.id, "gift_card", 1000, gift.code, requestKey)).status).toBe(201);
  const [count] = await t.db.execute<{ n: number }>(
    sql`select count(*)::int as n from gift_card_movement where kind = 'redemption'`,
  );
  expect(count?.n).toBe(1);
});
test("refunds restore redeemed value once and purchase refunds cannot return spent gift value", async () => {
  const gift = await active();
  const checkout = await sale(600);
  const paid = await pay(checkout.id, "gift_card", 600, gift.code);
  expect(paid.status).toBe(201);
  const { payment } = (await paid.json()) as { payment: { id: string } };
  expect((await refund(gift.payment.id, 500)).status).toBe(409);
  expect((await refund(gift.payment.id, 400)).status).toBe(201);
  expect(await card(gift.card.id)).toMatchObject({ balanceCents: 0 });
  const refundKey = key();
  expect((await refund(payment.id, 600, refundKey)).status).toBe(201);
  expect((await refund(payment.id, 600, refundKey)).status).toBe(201);
  expect(await card(gift.card.id)).toMatchObject({ balanceCents: 600, availableCents: 600 });
});
test("unknown bank purchase refunds hold value until reconciled and are dispatched only once", async () => {
  const gift = await buy();
  const payment = await pay(gift.checkout.id, "redsys_card", 1000);
  expect(payment.status).toBe(201);
  const started = (await payment.json()) as { payment: { id: string; order: string } };
  expect((await notify(started.payment.order, 1000)).status).toBe(200);
  const code = await reveal(gift.card.id);
  const requested = await refund(started.payment.id, 700);
  expect(requested.status).toBe(201);
  const pending = (await requested.json()) as { id: string };
  expect(await card(gift.card.id)).toMatchObject({
    balanceCents: 1000,
    reservedCents: 700,
    availableCents: 300,
  });
  expect((await pay((await sale(400)).id, "gift_card", 400, code)).status).toBe(409);
  expect((await pay((await sale(300)).id, "gift_card", 300, code)).status).toBe(201);
  refundOutcome = "unknown";
  expect(
    (await call(owner, `/admin/commerce/refunds/${pending.id}/execute`, "POST", {})).status,
  ).toBe(200);
  expect(
    (await call(owner, `/admin/commerce/refunds/${pending.id}/execute`, "POST", {})).status,
  ).toBe(200);
  expect(dispatches).toBe(1);
  expect(await card(gift.card.id)).toMatchObject({
    balanceCents: 700,
    reservedCents: 700,
    availableCents: 0,
  });
  expect(
    (
      await call(owner, `/admin/commerce/refunds/${pending.id}/reconcile`, "POST", {
        outcome: "failed",
        reference: "Verified not refunded in bank portal",
      })
    ).status,
  ).toBe(200);
  expect(await card(gift.card.id)).toMatchObject({
    balanceCents: 700,
    reservedCents: 0,
    availableCents: 700,
  });
});
test("expiry and code reissue require manager authority and preserve the stored value", async () => {
  const gift = await active();
  await t.db.execute(
    sql`update gift_card set expires_at = now() - interval '1 second' where id = ${gift.card.id}`,
  );
  expect((await pay((await sale()).id, "gift_card", 1000, gift.code)).status).toBe(409);
  const expired = await card(gift.card.id);
  expect(expired.status).toBe("expired");
  expect(
    (
      await call(client, `/me/gift-cards/${gift.card.id}/expiry`, "PATCH", {
        expiresAt: null,
        version: expired.version,
        reason: "Extend validity",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await call(owner, `/admin/gift-cards/${gift.card.id}/expiry`, "PATCH", {
        expiresAt: null,
        version: expired.version,
        reason: "Extend validity",
      })
    ).status,
  ).toBe(200);
  const current = await card(gift.card.id);
  const reissued = await call(owner, `/admin/gift-cards/${gift.card.id}/reissue`, "POST", {
    version: current.version,
    reason: "Lost gift voucher",
  });
  expect(reissued.status).toBe(200);
  const replacement = await reveal(gift.card.id);
  expect(replacement).not.toBe(gift.code);
  expect((await pay((await sale()).id, "gift_card", 1000, gift.code)).status).toBe(409);
  expect((await pay((await sale()).id, "gift_card", 1000, replacement)).status).toBe(201);
});
test("buyer card history is private, bearer balance checks expose no buyer data and gifts cannot buy other gifts", async () => {
  const purchase = await buy(1000, {}, client);
  expect((await pay(purchase.checkout.id, "external_card", 1000)).status).toBe(201);
  const code = await reveal(purchase.card.id, client);
  expect((await call(other, `/me/gift-cards/${purchase.card.id}`)).status).toBe(404);
  const checked = await call(other, "/me/gift-cards/check", "POST", { code });
  expect(checked.status).toBe(200);
  const balance = (await checked.json()) as Record<string, unknown>;
  expect(balance.availableCents).toBe(1000);
  expect(balance.buyerClientId).toBeUndefined();
  expect(balance.checkoutId).toBeUndefined();
  const another = await buy();
  expect((await pay(another.checkout.id, "gift_card", 1000, code)).status).toBe(409);
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(new Date());
  const report = (await (
    await call(owner, `/admin/accounting/sales?from=${date}&to=${date}`)
  ).json()) as { collectedCents: number };
  expect(report.collectedCents).toBe(1000);
});
test("gift redemption is stored value rather than a second collection of cash", async () => {
  const gift = await active();
  const checkout = await sale(600);
  const response = await pay(checkout.id, "gift_card", 600, gift.code);
  expect(response.status).toBe(201);
  const { payment } = (await response.json()) as { payment: { id: string } };
  expect((await refund(payment.id, 200)).status).toBe(201);
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(new Date());
  const report = (await (
    await call(owner, `/admin/accounting/sales?from=${date}&to=${date}`)
  ).json()) as Record<string, unknown>;
  expect(report).toMatchObject({
    collectedCents: 1000,
    refundedCents: 0,
    netCollectedCents: 1000,
    storedValueAppliedCents: 600,
    storedValueReturnedCents: 200,
    soldCents: 600,
    giftValueIssuedCents: 1000,
  });
});
test("late excess bank capture restores covered gift value and refunding excess does not reduce it", async () => {
  const gift = await buy();
  const pending = await pay(gift.checkout.id, "redsys_card", 1000);
  const { payment } = (await pending.json()) as { payment: { id: string; order: string } };
  await t.db.execute(
    sql`update checkout_payment set updated_at = now() - interval '2 minutes' where id = ${payment.id}`,
  );
  expect(
    (
      await call(owner, `/admin/commerce/payments/${payment.id}/reconcile`, "POST", {
        outcome: "failed",
        reference: "No capture visible in bank portal",
      })
    ).status,
  ).toBe(200);
  const collected = await pay(gift.checkout.id, "external_card", 1000);
  const manual = (await collected.json()) as { payment: { id: string } };
  expect((await refund(manual.payment.id, 300)).status).toBe(201);
  expect(await card(gift.card.id)).toMatchObject({ balanceCents: 700 });
  expect((await notify(payment.order, 1000)).status).toBe(200);
  expect((await notify(payment.order, 1000)).status).toBe(200);
  expect(await card(gift.card.id)).toMatchObject({ balanceCents: 1000, reservedCents: 0 });
  const requested = await refund(payment.id, 700);
  expect(requested.status).toBe(201);
  const bankRefund = (await requested.json()) as { id: string };
  expect(await card(gift.card.id)).toMatchObject({ balanceCents: 1000, reservedCents: 0 });
  expect(
    (await call(owner, `/admin/commerce/refunds/${bankRefund.id}/execute`, "POST", {})).status,
  ).toBe(200);
  expect(await card(gift.card.id)).toMatchObject({ balanceCents: 1000, reservedCents: 0 });
});
test("a client redeems a bearer card only against their own appointment receipt", async () => {
  const gift = await active();
  const { appointment, appointmentService } = await import("@sob/db");
  const [booking] = await t.db
    .insert(appointment)
    .values({
      staffId: fixtures.anaId,
      clientId: client.clientId ?? "",
      startsAt: new Date("2026-03-09T12:00:00Z"),
      endsAt: new Date("2026-03-09T13:00:00Z"),
    })
    .returning();
  if (!booking) throw new Error("Missing appointment");
  await t.db.insert(appointmentService).values({
    appointmentId: booking.id,
    serviceId: fixtures.haircutId,
    position: 0,
    name: "Haircut",
    durationMinutes: 45,
    bufferMinutes: 15,
    priceCents: 1000,
    currency: "EUR",
  });
  const response = await call(client, "/me/checkouts", "POST", {
    appointmentId: booking.id,
    idempotencyKey: key(),
  });
  expect(response.status).toBe(201);
  const checkout = (await response.json()) as { id: string };
  expect(
    (
      await call(other, `/me/checkouts/${checkout.id}/payments`, "POST", {
        method: "gift_card",
        amountCents: 1000,
        giftCardCode: gift.code,
        idempotencyKey: key(),
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await call(client, `/me/checkouts/${checkout.id}/payments`, "POST", {
        method: "gift_card",
        amountCents: 1000,
        giftCardCode: gift.code,
        idempotencyKey: key(),
      })
    ).status,
  ).toBe(201);
  expect(await card(gift.card.id)).toMatchObject({ balanceCents: 0 });
});
test("server key rotation preserves redemption of existing codes and an owner can reissue for later revelation", async () => {
  const gift = await active();
  const originalSecret = t.config.auth.secret;
  try {
    t.config.auth.secret = "changed-server-gift-code-key-0123456789012345";
    expect((await call(owner, `/admin/gift-cards/${gift.card.id}/code`, "POST", {})).status).toBe(
      409,
    );
    expect((await pay((await sale(200)).id, "gift_card", 200, gift.code)).status).toBe(201);
    const current = await card(gift.card.id);
    expect(
      (
        await call(owner, `/admin/gift-cards/${gift.card.id}/reissue`, "POST", {
          version: current.version,
          reason: "Server signing key rotated",
        })
      ).status,
    ).toBe(200);
    const replacement = await reveal(gift.card.id);
    expect(replacement).not.toBe(gift.code);
    expect((await pay((await sale(800)).id, "gift_card", 800, replacement)).status).toBe(201);
  } finally {
    t.config.auth.secret = originalSecret;
  }
});
test("fully returned purchases close their gift value and late bank captures remain refundable money", async () => {
  const gift = await buy();
  const pending = await pay(gift.checkout.id, "redsys_card", 1000);
  const { payment } = (await pending.json()) as { payment: { id: string; order: string } };
  await t.db.execute(
    sql`update checkout_payment set updated_at = now() - interval '2 minutes' where id = ${payment.id}`,
  );
  expect(
    (
      await call(owner, `/admin/commerce/payments/${payment.id}/reconcile`, "POST", {
        outcome: "failed",
        reference: "No capture visible in bank portal",
      })
    ).status,
  ).toBe(200);
  const partial = await pay(gift.checkout.id, "external_card", 200);
  const collected = (await partial.json()) as { payment: { id: string } };
  expect((await refund(collected.payment.id, 200)).status).toBe(201);
  expect(await card(gift.card.id)).toMatchObject({ status: "void", balanceCents: 0 });
  expect((await notify(payment.order, 1000)).status).toBe(200);
  const receipt = (await (
    await call(owner, `/admin/commerce/checkouts/${gift.checkout.id}`)
  ).json()) as { status: string; payments: { id: string; status: string }[] };
  expect(receipt.status).toBe("void");
  expect(receipt.payments.find((p) => p.id === payment.id)?.status).toBe("reconciliation");
  expect(await card(gift.card.id)).toMatchObject({ status: "void", balanceCents: 0 });
  const fullyPaid = await active();
  expect((await refund(fullyPaid.payment.id, 1000)).status).toBe(201);
  expect(await card(fullyPaid.card.id)).toMatchObject({ status: "void", balanceCents: 0 });
  expect((await pay((await sale()).id, "gift_card", 1000, fullyPaid.code)).status).toBe(409);
});

test("purchase replay returns its original receipt even after the requested expiry has passed", async () => {
  const expiry = Date.now() + 60000;
  const requestKey = key();
  const input = { expiresAt: new Date(expiry).toISOString(), idempotencyKey: requestKey };
  const purchase = await buy(1000, input);
  const clock = spyOn(Date, "now").mockReturnValue(expiry + 1000);
  try {
    expect((await buy(1000, input)).card.id).toBe(purchase.card.id);
  } finally {
    clock.mockRestore();
  }
});

test("gift status filtering uses effective expiry before counting and paginating", async () => {
  const pending = await buy();
  const paid = await active();
  const expired = await active();
  await t.db.execute(
    sql`update gift_card set expires_at=now()-interval '1 day' where id=${expired.card.id}::uuid`,
  );
  for (const [status, expected] of [
    ["pending", pending.card.id],
    ["active", paid.card.id],
    ["expired", expired.card.id],
  ] as const) {
    const response = await call(owner, `/admin/gift-cards?status=${status}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      cards: { id: string; status: string }[];
      pagination: { total: number };
    };
    expect(body.pagination.total).toBe(1);
    expect(body.cards).toMatchObject([{ id: expected, status }]);
  }
  expect((await call(owner, "/admin/gift-cards?status=other")).status).toBe(400);
});
