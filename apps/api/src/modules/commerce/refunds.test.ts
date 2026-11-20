import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { checkoutSchema, DESKTOP_CLIENT_ID, DESKTOP_SIGN_IN_SCOPE } from "@sob/contracts";
import { auditLog, checkoutPayment, checkoutRefund } from "@sob/db";
import { eq } from "drizzle-orm";
import { type Actor, actor, json, seedFixtures, setupApiTest } from "../../../test/helpers";
import { obtainTokens } from "../../../test/oauth";
import { desktopResource } from "../../oauth/desktop";
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

test("cancelling an undispatched reservation releases its amount and is idempotent", async () => {
  const refund = await requestRefund(700);
  const path = `/admin/commerce/refunds/${refund.id}/cancel`;
  const employee = await actor(t, "staff", "cannot-cancel-refund@example.test");
  expect((await json(t.app, path, "POST", {}, employee.cookie)).status).toBe(403);
  const cancelled = await call(path, {});
  expect(cancelled.status).toBe(200);
  const view = (await cancelled.json()) as Record<string, unknown>;
  expect(view.id).toBe(refund.id);
  expect(view.status).toBe("failed");
  expect(view.cancelledAt).toBeString();
  expect(Object.keys(view).sort()).toEqual([
    "amountCents",
    "cancelledAt",
    "createdAt",
    "id",
    "paymentId",
    "reason",
    "status",
    "updatedAt",
  ]);
  expect(await (await call(path, {})).json()).toEqual(view);
  expect((await call(`/admin/commerce/refunds/${refund.id}/execute`, {})).status).toBe(409);
  expect(dispatches).toBe(0);
  const receipt = checkoutSchema.parse(
    await (await call(`/admin/commerce/checkouts/${checkoutId}`)).json(),
  );
  expect(receipt.refundedCents).toBe(0);
  expect(receipt.refunds.find((row) => row.id === refund.id)?.cancelledAt).toBeString();
  const audited = await t.db.select().from(auditLog).where(eq(auditLog.entityId, refund.id));
  expect(audited.filter((entry) => entry.action === "commerce.refund_cancelled")).toHaveLength(1);
  expect((await requestRefund(1000)).status).toBe("requested");
});

test("a competing cancellation and send cannot both succeed", async () => {
  const refund = await requestRefund(400);
  const path = `/admin/commerce/refunds/${refund.id}`;
  const [cancel, execute] = await Promise.all([
    call(`${path}/cancel`, {}),
    call(`${path}/execute`, {}),
  ]);
  expect([cancel.status, execute.status].sort()).toEqual([200, 409]);
  expect(dispatches).toBe(execute.status === 200 ? 1 : 0);
});
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

test("desktop access can reserve, dispatch and reconcile an uncertain refund exactly once", async () => {
  const authorize = async (user: Actor) => {
    const result = await obtainTokens(t.app, {
      clientId: DESKTOP_CLIENT_ID,
      cookie: user.cookie,
      scope: `${DESKTOP_SIGN_IN_SCOPE} offline_access`,
      resource: desktopResource("http://localhost:3000"),
      redirectUri: "http://127.0.0.1:63282/callback",
    });
    return String(result.tokens.access_token);
  };
  const access = await authorize(owner);
  const staff = await actor(t, "staff", "refund-professional@example.test");
  const staffAccess = await authorize(staff);
  const desktop = (path: string, body?: unknown, token = access) =>
    t.app.request(path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const requestPath = `/admin/commerce/payments/${paymentId}/refunds`;
  const request = {
    amountCents: 500,
    reason: "Synthetic refund from desktop",
    idempotencyKey: crypto.randomUUID(),
  };
  expect((await desktop(requestPath, request, staffAccess)).status).toBe(403);
  const reserved = await desktop(requestPath, request);
  expect(reserved.status).toBe(201);
  const { id, status } = (await reserved.json()) as { id: string; status: string };
  expect(status).toBe("requested");
  expect(await (await desktop(requestPath, request)).json()).toMatchObject({ id });
  expect(dispatches).toBe(0);

  const dispatch = `/admin/commerce/refunds/${id}/execute`;
  expect((await desktop(dispatch)).status).toBe(403);
  expect((await desktop(dispatch, {}, staffAccess)).status).toBe(403);
  mode = "unknown";
  const attempted = await desktop(dispatch, {});
  expect(attempted.status).toBe(200);
  expect(await attempted.json()).toMatchObject({ status: "reconciliation" });
  expect((await desktop(dispatch, {})).status).toBe(200);
  expect(dispatches).toBe(1);
  const receiptPath = `/admin/commerce/checkouts/${checkoutId}`;
  const uncertain = checkoutSchema.parse(await (await desktop(receiptPath)).json());
  expect(uncertain.canDispatchBankRefunds).toBe(true);
  expect(uncertain.refunds.find((refund) => refund.id === id)?.reconcileAfter).toBeString();
  const reconcile = `/admin/commerce/refunds/${id}/reconcile`;
  const evidence = { outcome: "succeeded", reference: "Synthetic bank refund REF-500" };
  expect((await desktop(reconcile, evidence, staffAccess)).status).toBe(403);
  expect((await desktop(reconcile, evidence)).status).toBe(200);
  expect((await desktop(reconcile, evidence)).status).toBe(409);
  const confirmed = checkoutSchema.parse(await (await call(receiptPath)).json());
  expect(confirmed.refundedCents).toBe(500);
  expect(confirmed.refunds.find((refund) => refund.id === id)?.status).toBe("succeeded");
  const pending = await desktop(requestPath, { ...request, idempotencyKey: crypto.randomUUID() });
  const another = (await pending.json()) as { id: string };
  const cancel = `/admin/commerce/refunds/${another.id}/cancel`;
  expect((await desktop(cancel, {}, staffAccess)).status).toBe(403);
  expect((await desktop(cancel, {})).status).toBe(200);
  expect(dispatches).toBe(1);
});
