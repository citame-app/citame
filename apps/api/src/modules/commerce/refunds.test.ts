import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { checkoutPayment, checkoutRefund } from "@sob/db";
import { eq } from "drizzle-orm";
import { type Actor, actor, json, seedFixtures, setupApiTest } from "../../../test/helpers";
import { RedsysGateway } from "../../payments/redsys";

const secret = "sq7HjrUOBfKmC576ILgskD5srU870gJ7";
const bank = new RedsysGateway({
  secret,
  merchantCode: "999008881",
  terminal: "001",
  environment: "test",
  publicURL: "http://localhost:3000",
});
let dispatches = 0;
let mode: "success" | "unknown" = "success";
let t: Awaited<ReturnType<typeof setupApiTest>>;
let owner: Actor;
let paymentId: string;
let checkoutId: string;
const call = (path: string, body?: unknown) =>
  json(t.app, path, body ? "POST" : "GET", body, owner.cookie);
beforeAll(async () => {
  t = await setupApiTest({
    dbSuffix: "commerce_refunds",
    deps: {
      paymentGateway: {
        provider: "redsys",
        environment: "test",
        checkout: (input) => bank.checkout(input),
        verify: (input) => bank.verify(input),
        refund: async (input) => {
          dispatches++;
          if (mode === "unknown") throw new Error("timeout");
          return {
            order: input.order,
            amountCents: input.amountCents,
            currency: "EUR",
            transactionType: "3",
            responseCode: "0900",
            success: true,
            authorizationCode: null,
          };
        },
      },
    },
  });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  await seedFixtures(t.db);
  owner = await actor(t, "owner", "refund-owner@example.com");
  dispatches = 0;
  mode = "success";
  const sale = await call("/admin/commerce/checkouts", {
    lines: [{ kind: "custom", description: "Treatment", quantity: 1, unitAmountCents: 1000 }],
    idempotencyKey: crypto.randomUUID(),
  });
  checkoutId = ((await sale.json()) as { id: string }).id;
  const created = await call(`/admin/commerce/checkouts/${checkoutId}/payments`, {
    amountCents: 1000,
    method: "redsys_card",
    idempotencyKey: crypto.randomUUID(),
  });
  paymentId = ((await created.json()) as { payment: { id: string } }).payment.id;
  await t.db
    .update(checkoutPayment)
    .set({ status: "succeeded" })
    .where(eq(checkoutPayment.id, paymentId));
});
async function requestRefund(amountCents: number) {
  const response = await call(`/admin/commerce/payments/${paymentId}/refunds`, {
    amountCents,
    reason: "Customer requested",
    idempotencyKey: crypto.randomUUID(),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; status: string };
}
test("a bank refund is reserved, dispatched once and then reflected in the receipt", async () => {
  const refund = await requestRefund(400);
  expect(refund.status).toBe("requested");
  const [a, b] = await Promise.all([
    call(`/admin/commerce/refunds/${refund.id}/execute`, {}),
    call(`/admin/commerce/refunds/${refund.id}/execute`, {}),
  ]);
  expect(a.status).toBe(200);
  expect(b.status).toBe(200);
  expect(dispatches).toBe(1);
  const view = (await (await call(`/admin/commerce/checkouts/${checkoutId}`)).json()) as {
    refundedCents: number;
    status: string;
  };
  expect(view).toMatchObject({ refundedCents: 400, status: "partially_refunded" });
  expect(
    (
      await call(`/admin/commerce/payments/${paymentId}/refunds`, {
        amountCents: 700,
        reason: "Too much",
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(409);
});
test("lost bank responses remain reserved and require explicit reconciliation without automatic retry", async () => {
  const refund = await requestRefund(500);
  mode = "unknown";
  expect((await call(`/admin/commerce/refunds/${refund.id}/execute`, {})).status).toBe(200);
  expect((await call(`/admin/commerce/refunds/${refund.id}/execute`, {})).status).toBe(200);
  expect(dispatches).toBe(1);
  const [row] = await t.db.select().from(checkoutRefund).where(eq(checkoutRefund.id, refund.id));
  expect(row?.status).toBe("reconciliation");
  const resolved = await call(`/admin/commerce/refunds/${refund.id}/reconcile`, {
    outcome: "succeeded",
    reference: "Bank portal confirmed refund REF-123",
  });
  expect(resolved.status).toBe(200);
  expect(
    (
      (await (await call(`/admin/commerce/checkouts/${checkoutId}`)).json()) as {
        refundedCents: number;
      }
    ).refundedCents,
  ).toBe(500);
});

test("a refund still in flight cannot be reconciled before its dispatch lease has elapsed", async () => {
  const refund = await requestRefund(300);
  await t.db
    .update(checkoutRefund)
    .set({ status: "dispatched", updatedAt: new Date() })
    .where(eq(checkoutRefund.id, refund.id));
  const body = { outcome: "failed", reference: "Bank portal checked REF-LEASE" };
  expect((await call(`/admin/commerce/refunds/${refund.id}/reconcile`, body)).status).toBe(409);
  await t.db
    .update(checkoutRefund)
    .set({ updatedAt: new Date(Date.now() - 120_000) })
    .where(eq(checkoutRefund.id, refund.id));
  expect((await call(`/admin/commerce/refunds/${refund.id}/reconcile`, body)).status).toBe(200);
});
