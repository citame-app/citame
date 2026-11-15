import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { checkoutSchema } from "@sob/contracts";
import { appointment, appointmentService } from "@sob/db";
import { sql } from "drizzle-orm";
import {
  type Actor,
  actor,
  type Fixtures,
  json,
  seedFixtures,
  setupApiTest,
} from "../../../test/helpers";
import { redsysSignature } from "../../payments/redsys";

const bankSecret = "sq7HjrUOBfKmC576ILgskD5srU870gJ7"; // Official public test fixture.
let t: Awaited<ReturnType<typeof setupApiTest>>;
let f: Fixtures;
let owner: Actor;
let staff: Actor;
let client: Actor;
let other: Actor;
let appointmentId: string;
const call = (who: Actor | null, path: string, method = "GET", body?: unknown) =>
  json(t.app, path, method, body, who?.cookie);
const checkout = async (who = owner, extra: Record<string, unknown> = {}) => {
  const res = await call(
    who,
    who.clientId !== null ? "/me/checkouts" : "/admin/commerce/checkouts",
    "POST",
    { appointmentId, idempotencyKey: crypto.randomUUID(), ...extra },
  );
  expect(res.status, await res.clone().text()).toBe(201);
  return checkoutSchema.parse(await res.json());
};
const pay = (
  id: string,
  method: string,
  amountCents: number,
  idempotencyKey = crypto.randomUUID(),
  who = owner,
) =>
  call(
    who,
    `${who.clientId !== null ? "/me" : "/admin/commerce"}/checkouts/${id}/payments`,
    "POST",
    { method, amountCents, idempotencyKey },
  );
const notify = (order: string, extra: Record<string, string> = {}, tamper = false) => {
  const encoded = Buffer.from(
    JSON.stringify({
      Ds_Order: order,
      Ds_Amount: "10000",
      Ds_Currency: "978",
      Ds_MerchantCode: "999008881",
      Ds_Terminal: "1",
      Ds_Response: "0000",
      Ds_TransactionType: "0",
      ...extra,
    }),
  ).toString("base64url");
  return t.app.request("/payments/redsys/notify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      Ds_MerchantParameters: encoded,
      Ds_SignatureVersion: "HMAC_SHA512_V2",
      Ds_Signature: tamper ? "A".repeat(86) : redsysSignature(bankSecret, order, encoded),
    }),
  });
};
beforeAll(async () => {
  t = await setupApiTest({
    dbSuffix: "commerce",
    env: {
      PAYMENT_PROVIDER: "redsys",
      REDSYS_MERCHANT_CODE: "999008881",
      REDSYS_TERMINAL: "001",
      REDSYS_SECRET_KEY: bankSecret,
      REDSYS_ENVIRONMENT: "test",
      REDSYS_BIZUM_ENABLED: "true",
    },
  });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  f = await seedFixtures(t.db);
  [owner, staff, client, other] = await Promise.all([
    actor(t, "owner", "owner@commerce.test"),
    actor(t, "staff", "staff@commerce.test", { staffProfileId: f.anaId }),
    actor(t, "client", "client@commerce.test"),
    actor(t, "client", "other@commerce.test"),
  ]);
  const principal = client;
  if (!principal.clientId) throw new Error("Client profile missing");
  const [row] = await t.db
    .insert(appointment)
    .values({
      staffId: f.anaId,
      clientId: principal.clientId,
      startsAt: new Date("2026-03-09T12:00:00Z"),
      endsAt: new Date("2026-03-09T13:00:00Z"),
    })
    .returning();
  if (!row) throw new Error("Appointment insert failed");
  appointmentId = row.id;
  await t.db.insert(appointmentService).values({
    appointmentId,
    serviceId: f.haircutId,
    position: 0,
    name: "Haircut",
    durationMinutes: 45,
    bufferMinutes: 15,
    priceCents: 10000,
    currency: "EUR",
  });
});

test("builds totals from immutable appointment snapshots, not a browser total", async () => {
  const result = await checkout(owner, { discountCents: 1000, tipCents: 500 });
  expect(result).toMatchObject({
    status: "open",
    subtotalCents: 10000,
    discountCents: 1000,
    tipCents: 500,
    totalCents: 9500,
    balanceCents: 9500,
    paidCents: 0,
  });
  expect(result.lines[0]).toMatchObject({ description: "Haircut", unitAmountCents: 10000 });
  expect(
    (
      await call(client, "/me/checkouts", "POST", {
        appointmentId,
        discountCents: 9999,
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(403);
});
test("clients see and pay only their own orders and cannot record manual cash", async () => {
  const result = await checkout(client);
  expect((await call(other, `/me/checkouts/${result.id}`)).status).toBe(404);
  expect((await pay(result.id, "redsys_card", 10000, crypto.randomUUID(), other)).status).toBe(404);
  expect((await pay(result.id, "cash", 10000, crypto.randomUUID(), client)).status).toBe(403);
  expect((await call(null, "/admin/commerce/checkouts")).status).toBe(401);
  expect((await call(client, "/admin/commerce/checkouts")).status).toBe(403);
});
test("a hosted checkout stays unpaid until a matching signed bank notification", async () => {
  const sale = await checkout(client);
  const response = await pay(sale.id, "redsys_card", 10000, crypto.randomUUID(), client);
  expect(response.status).toBe(201);
  const started = (await response.json()) as {
    payment: { order: string; status: string };
    form: { action: string };
  };
  expect(started.form.action).toContain("sis-t.redsys.es");
  expect(started.payment.status).toBe("pending");
  expect(
    checkoutSchema.parse(await (await call(client, `/me/checkouts/${sale.id}`)).json()).paidCents,
  ).toBe(0);
  expect((await notify(started.payment.order, {}, true)).status).toBe(400);
  expect((await notify(started.payment.order, { Ds_Amount: "1" })).status).toBe(400);
  expect((await notify(started.payment.order)).status).toBe(200);
  expect((await notify(started.payment.order)).status).toBe(200);
  const paid = checkoutSchema.parse(await (await call(client, `/me/checkouts/${sale.id}`)).json());
  expect(paid).toMatchObject({ status: "paid", paidCents: 10000, balanceCents: 0 });
  expect(paid.payments).toHaveLength(1);
  expect((await notify(started.payment.order, { Ds_Response: "0190" })).status).toBe(200);
  expect(
    checkoutSchema.parse(await (await call(client, `/me/checkouts/${sale.id}`)).json()).status,
  ).toBe("paid");
});
test("a bank decline releases the balance and pending attempts prevent a second collection", async () => {
  const sale = await checkout();
  const started = (await (await pay(sale.id, "redsys_bizum", 10000)).json()) as {
    payment: { order: string };
  };
  expect((await pay(sale.id, "redsys_card", 10000)).status).toBe(409);
  await notify(started.payment.order, { Ds_Response: "0190" });
  const current = checkoutSchema.parse(
    await (await call(owner, `/admin/commerce/checkouts/${sale.id}`)).json(),
  );
  expect(current).toMatchObject({ status: "open", paidCents: 0 });
  expect(current.payments[0]?.status).toBe("failed");
  expect((await pay(sale.id, "redsys_card", 10000)).status).toBe(201);
});
test("checkout and payment idempotency reject changed payloads and concurrent overspending", async () => {
  const key = crypto.randomUUID();
  const a = await checkout(owner, { idempotencyKey: key });
  const replay = await call(owner, "/admin/commerce/checkouts", "POST", {
    appointmentId,
    idempotencyKey: key,
  });
  expect(checkoutSchema.parse(await replay.json()).id).toBe(a.id);
  expect(
    (
      await call(owner, "/admin/commerce/checkouts", "POST", {
        appointmentId,
        idempotencyKey: key,
        tipCents: 100,
      })
    ).status,
  ).toBe(409);
  const paymentKey = crypto.randomUUID();
  const first = await pay(a.id, "redsys_card", 10000, paymentKey);
  const second = await pay(a.id, "redsys_card", 10000, paymentKey);
  expect(((await first.json()) as { payment: { id: string } }).payment.id).toBe(
    ((await second.json()) as { payment: { id: string } }).payment.id,
  );
  expect((await pay(a.id, "redsys_card", 1000, paymentKey)).status).toBe(409);
});
test("cash sessions reconcile partial payments, movements, tips and refunds exactly once", async () => {
  expect(
    (await call(client, "/admin/commerce/cash-sessions", "POST", { openingCents: 5000 })).status,
  ).toBe(403);
  const opened = await call(owner, "/admin/commerce/cash-sessions", "POST", { openingCents: 5000 });
  expect(opened.status).toBe(201);
  const session = (await opened.json()) as { id: string };
  expect(
    (await call(owner, "/admin/commerce/cash-sessions", "POST", { openingCents: 0 })).status,
  ).toBe(409);
  const sale = await checkout(owner, { tipCents: 500 });
  const key = crypto.randomUUID();
  const cash = await pay(sale.id, "cash", 5000, key, staff);
  expect(cash.status).toBe(201);
  await pay(sale.id, "cash", 5000, key, staff);
  expect((await pay(sale.id, "external_card", 5500, crypto.randomUUID(), staff)).status).toBe(201);
  const paid = checkoutSchema.parse(
    await (await call(owner, `/admin/commerce/checkouts/${sale.id}`)).json(),
  );
  expect(paid).toMatchObject({ paidCents: 10500, balanceCents: 0, status: "paid" });
  const paymentId = ((await cash.json()) as { payment: { id: string } }).payment.id;
  const refundKey = crypto.randomUUID();
  const body = { amountCents: 1000, reason: "Partial refund", idempotencyKey: refundKey };
  expect(
    (await call(staff, `/admin/commerce/payments/${paymentId}/refunds`, "POST", body)).status,
  ).toBe(403);
  expect(
    (await call(owner, `/admin/commerce/payments/${paymentId}/refunds`, "POST", body)).status,
  ).toBe(201);
  await call(owner, `/admin/commerce/payments/${paymentId}/refunds`, "POST", body);
  expect(
    checkoutSchema.parse(await (await call(owner, `/admin/commerce/checkouts/${sale.id}`)).json())
      .refundedCents,
  ).toBe(1000);
  const closed = await call(owner, `/admin/commerce/cash-sessions/${session.id}/close`, "POST", {
    countedCents: 8900,
  });
  expect(closed.status).toBe(200);
  expect(await closed.json()).toMatchObject({
    expectedCents: 9000,
    countedCents: 8900,
    differenceCents: -100,
  });
});

test("concurrent partial cash payments cannot exceed the order and cash counts cannot be rewritten", async () => {
  const opened = (await (
    await call(owner, "/admin/commerce/cash-sessions", "POST", { openingCents: 0 })
  ).json()) as { id: string };
  const sale = await checkout();
  const results = await Promise.all([pay(sale.id, "cash", 7000), pay(sale.id, "cash", 7000)]);
  expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  const view = checkoutSchema.parse(
    await (await call(owner, `/admin/commerce/checkouts/${sale.id}`)).json(),
  );
  expect(view).toMatchObject({ paidCents: 7000, balanceCents: 3000 });
  expect(
    (
      await call(owner, `/admin/commerce/cash-sessions/${opened.id}/close`, "POST", {
        countedCents: 7000,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call(owner, `/admin/commerce/cash-sessions/${opened.id}/close`, "POST", {
        countedCents: 0,
      })
    ).status,
  ).toBe(409);
  expect((await pay(sale.id, "cash", 3000)).status).toBe(409);
});
test("currency mismatches and cross-origin browser mutations cannot create a charge", async () => {
  await t.db.update(appointmentService).set({ currency: "ARS" });
  expect(
    (
      await call(owner, "/admin/commerce/checkouts", "POST", {
        appointmentId,
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(400);
  const response = await t.app.request("/admin/commerce/checkouts", {
    method: "POST",
    headers: {
      cookie: owner.cookie,
      origin: "https://attacker.example",
      "content-type": "application/json",
    },
    body: JSON.stringify({ appointmentId, idempotencyKey: crypto.randomUUID() }),
  });
  expect(response.status).toBe(403);
});
test("financial mutations are audited and duplicate callbacks do not create duplicate audit entries", async () => {
  const sale = await checkout();
  const started = (await (await pay(sale.id, "redsys_card", 10000)).json()) as {
    payment: { order: string };
  };
  await notify(started.payment.order);
  await notify(started.payment.order);
  const rows = await t.db.execute<{ action: string }>(
    sql`select action from audit_log where action like 'commerce.%' order by created_at`,
  );
  expect(rows.map((row) => row.action)).toEqual([
    "commerce.checkout_created",
    "commerce.payment_started",
    "commerce.payment_settled",
  ]);
});

test("a client can open an existing staff-priced receipt without overriding its discount", async () => {
  const sale = await checkout(owner, { discountCents: 1000 });
  const response = await call(client, "/me/checkouts", "POST", {
    appointmentId,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(response.status).toBe(201);
  expect(checkoutSchema.parse(await response.json())).toMatchObject({
    id: sale.id,
    totalCents: 9000,
    discountCents: 1000,
  });
});
test("register withdrawals cannot create negative physical cash", async () => {
  await call(owner, "/admin/commerce/cash-sessions", "POST", { openingCents: 5000 });
  expect(
    (
      await call(owner, "/admin/commerce/cash-sessions/adjust", "POST", {
        kind: "withdrawal",
        amountCents: 5001,
        reason: "Supplier payment",
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(409);
});

test("oversized and repeated bank form fields are rejected as invalid notifications", async () => {
  for (const body of [`a=${"a".repeat(16001)}`, "Ds_Signature=x&Ds_Signature=y"]) {
    const response = await t.app.request("/payments/redsys/notify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    expect(response.status).toBe(400);
  }
});

test("late successful bank notifications remain in the ledger as excess funds requiring a refund", async () => {
  const sale = await checkout();
  const old = (await (await pay(sale.id, "redsys_card", 10000)).json()) as {
    payment: { id: string; order: string };
  };
  await notify(old.payment.order, { Ds_Response: "0190" });
  const current = (await (await pay(sale.id, "redsys_card", 10000)).json()) as {
    payment: { order: string };
  };
  await notify(current.payment.order);
  await notify(old.payment.order);
  const view = (await (await call(owner, `/admin/commerce/checkouts/${sale.id}`)).json()) as {
    paidCents: number;
    overpaidCents: number;
  };
  expect(view).toMatchObject({ paidCents: 20000, overpaidCents: 10000 });
  const refund = await call(owner, `/admin/commerce/payments/${old.payment.id}/refunds`, "POST", {
    amountCents: 10000,
    reason: "Return duplicate bank capture",
    idempotencyKey: crypto.randomUUID(),
  });
  expect(refund.status).toBe(201);
});
test("an abandoned bank attempt can be reconciled by an owner after checking the bank portal", async () => {
  const sale = await checkout();
  const payment = (await (await pay(sale.id, "redsys_card", 10000)).json()) as {
    payment: { id: string };
  };
  const body = { outcome: "failed", reference: "Bank portal confirms no charge REF-902" };
  const path = `/admin/commerce/payments/${payment.payment.id}/reconcile`;
  expect((await call(staff, path, "POST", body)).status).toBe(403);
  expect((await call(owner, path, "POST", body)).status).toBe(409);
  await t.db.execute(
    sql`update checkout_payment set updated_at = now() - interval '2 minutes' where id = ${payment.payment.id}`,
  );
  expect((await call(owner, path, "POST", body)).status).toBe(200);
  expect((await pay(sale.id, "external_card", 10000)).status).toBe(201);
});

test("a cash refund cannot spend cash absent from a newly opened drawer", async () => {
  const firstSession = (await (
    await call(owner, "/admin/commerce/cash-sessions", "POST", { openingCents: 0 })
  ).json()) as { id: string };
  const sale = await checkout();
  const paid = (await (await pay(sale.id, "cash", 10000)).json()) as { payment: { id: string } };
  await call(owner, `/admin/commerce/cash-sessions/${firstSession.id}/close`, "POST", {
    countedCents: 10000,
  });
  await call(owner, "/admin/commerce/cash-sessions", "POST", { openingCents: 0 });
  expect(
    (
      await call(owner, `/admin/commerce/payments/${paid.payment.id}/refunds`, "POST", {
        amountCents: 1000,
        reason: "Customer return",
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(409);
});
