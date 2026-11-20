import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { CheckoutPanel } from "./checkout-panel";

const id = "0198f5a0-7b1c-7000-8000-000000000100";
const realFetch = globalThis.fetch;
let requests: { method: string; path: string; body: unknown }[];
let paid = false;
let online = false;
let giftAvailable = false;
let payable: number | undefined;
let refunds: Record<string, unknown>[] = [];
let payments: Record<string, unknown>[] = [];
let pricePending = false;
let serviceAmount = 2500;
const sale = () => ({
  id,
  pricingVersion: pricePending ? 1 : 2,
  appointmentId: null,
  clientId: null,
  currency: "EUR",
  status: paid ? "paid" : "open",
  subtotalCents: serviceAmount,
  discountCents: 0,
  tipCents: 0,
  taxCents: 0,
  totalCents: serviceAmount,
  paidCents: paid ? 2500 : 0,
  refundedCents: 0,
  balanceCents: paid ? 0 : serviceAmount,
  payableCents: payable,
  lines: [
    {
      id,
      kind: "custom",
      description: "Haircut",
      quantity: 1,
      unitAmountCents: serviceAmount,
      pricePending,
      taxBasisPoints: 0,
    },
  ],
  payments,
  refunds,
  createdAt: "2026-03-09T12:00:00.000Z",
});
const reply = (data: unknown) => Response.json(data);
beforeEach(() => {
  pricePending = false;
  serviceAmount = 2500;
  requests = [];
  paid = false;
  online = false;
  giftAvailable = false;
  payable = undefined;
  refunds = [];
  payments = [];
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, path, body });
    if (path.endsWith("/prices") && method === "PUT") {
      pricePending = false;
      serviceAmount = body.lines[0].unitAmountCents;
      return reply(sale());
    }
    if (path.endsWith("/reconcile") && method === "POST") {
      paid = true;
      payments = payments.map((payment) => ({
        ...payment,
        status: "succeeded",
        reconcileAfter: undefined,
      }));
      return reply({ id, checkoutId: id, status: "succeeded" });
    }
    if (path.endsWith("/capabilities"))
      return reply({
        provider: online ? "redsys" : "none",
        environment: online ? "test" : null,
        card: online,
        giftCards: giftAvailable,
        bizum: online,
        currency: "EUR",
      });
    if (path.endsWith("/payments") && method === "POST") {
      if (body.method === "cash" || body.method === "gift_card") {
        paid = true;
        return reply({
          payment: { id, status: "succeeded", method: body.method, amountCents: 2500, order: null },
          form: null,
        });
      }
      return reply({
        payment: {
          id,
          status: "pending",
          method: "redsys_card",
          amountCents: 2500,
          order: "1234567890",
        },
        form: {
          action: "https://sis-t.redsys.es:25443/sis/realizarPago",
          fields: {
            Ds_MerchantParameters: "encoded",
            Ds_Signature: "signed",
            Ds_SignatureVersion: "HMAC_SHA512_V2",
          },
        },
      });
    }
    if (path.endsWith(`/checkouts/${id}`)) return reply(sale());
    return reply({});
  }) as unknown as typeof fetch;
});

test("payment reconciliation shows the order and uses the server's review window", async () => {
  const otherId = "0198f5a0-7b1c-7000-8000-000000000101";
  const attempt = {
    id,
    status: "pending",
    method: "redsys_card",
    amountCents: 2500,
    order: "120001000001",
    createdAt: "2026-03-09T12:00:00.000Z",
    reconcileAfter: "2026-03-09T12:01:00.000Z",
  };
  payments = [
    attempt,
    { ...attempt, id: otherId, order: "120001000002", reconcileAfter: "2100-01-01T00:00:00Z" },
  ];
  renderApp(<CheckoutPanel id={id} mode="admin" role="owner" />);
  await screen.findByText("Bank order · 120001000001");
  expect(screen.queryByText("Bank order · 120001000002")).toBeNull();
  fireEvent.change(screen.getByLabelText("Bank confirmation reference"), {
    target: { value: "BANK-2026-0001" },
  });
  fireEvent.change(screen.getByRole("combobox", { name: "Reconcile bank payment" }), {
    target: { value: "succeeded" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Reconcile bank payment" }));
  await waitFor(() =>
    expect(requests.find((r) => r.path.endsWith("/reconcile"))?.body).toEqual({
      outcome: "succeeded",
      reference: "BANK-2026-0001",
    }),
  );
});

test("unresolved prices block payment until the operator reviews and saves the final amount", async () => {
  pricePending = true;
  renderApp(<CheckoutPanel id={id} mode="admin" role="owner" />);
  const amount = await screen.findByLabelText("Haircut");
  expect(amount).toHaveValue("");
  expect(screen.queryByRole("button", { name: "Record payment" })).toBeNull();
  fireEvent.change(amount, { target: { value: "75,50" } });
  fireEvent.click(screen.getByRole("button", { name: "Set final prices" }));
  await waitFor(() =>
    expect(requests.some((r) => r.method === "PUT" && r.path.endsWith("/prices"))).toBe(true),
  );
  expect(requests.find((r) => r.path.endsWith("/prices"))?.body).toEqual({
    version: 1,
    lines: [{ id, unitAmountCents: 7550 }],
  });
  await waitFor(() => expect(screen.queryByLabelText("Haircut")).toBeNull());
});

test("a booking signal uses the payable deposit instead of charging the entire service balance", async () => {
  payable = 500;
  online = true;
  renderApp(<CheckoutPanel id={id} mode="client" role="client" />);
  expect(await screen.findByLabelText("Amount")).toHaveValue("5.00");
  fireEvent.click(screen.getByRole("button", { name: "Continue to payment" }));
  await waitFor(() =>
    expect(
      requests.some(
        (r) => r.method === "POST" && (r.body as { amountCents?: number })?.amountCents === 500,
      ),
    ).toBe(true),
  );
});

test("a confirmed signal with nothing payable now hides payment entry while retaining the remaining balance", async () => {
  payable = 0;
  online = true;
  renderApp(<CheckoutPanel id={id} mode="client" role="client" />);
  await screen.findByText("No payment is due before your visit.");
  expect(screen.queryByLabelText("Amount")).toBeNull();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});
test("shows the server receipt and records a cash payment once", async () => {
  renderApp(<CheckoutPanel id={id} mode="admin" role="owner" />);
  await screen.findByText("Haircut");
  fireEvent.change(screen.getByLabelText("Payment method"), { target: { value: "cash" } });
  fireEvent.click(screen.getByRole("button", { name: "Record payment" }));
  await screen.findByText("Paid", { selector: "p" });
  const posted = requests.filter((r) => r.method === "POST");
  expect(posted).toHaveLength(1);
  expect(posted[0]?.body).toMatchObject({ amountCents: 2500, method: "cash" });
  expect(screen.queryByRole("button", { name: "Record payment" })).toBeNull();
});
test("a hosted payment shows the bank form without claiming the order is paid", async () => {
  online = true;
  renderApp(<CheckoutPanel id={id} mode="client" role="client" />);
  await screen.findByText("Haircut");
  await waitFor(() =>
    expect(
      screen.getByRole("option", { name: "Card — secure online payment" }),
    ).toBeInTheDocument(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Continue to payment" }));
  const button = await screen.findByRole("button", { name: "Pay securely with Redsys" });
  const form = button.closest("form");
  if (!form) throw new Error("Hosted bank form missing");
  expect(form.getAttribute("action")).toBe("https://sis-t.redsys.es:25443/sis/realizarPago");
  expect(form.getAttribute("method")).toBe("post");
  expect(form.querySelector('input[name="Ds_Signature"]')).toHaveValue("signed");
  expect(screen.queryByText("Paid", { selector: "p" })).toBeNull();
  expect(screen.queryByRole("option", { name: "Cash" })).toBeNull();
});
test("Spanish users get a clear unavailable state when online payments have not been configured", async () => {
  renderApp(<CheckoutPanel id={id} mode="client" role="client" />, { locale: "es-AR" });
  await screen.findByText("Haircut");
  await screen.findByText("El pago online todavía no está disponible. Contacta con el salón.");
  expect(screen.queryByRole("button", { name: /Continuar al pago/ })).toBeNull();
});

test("an unresolved bank refund remains visible after reopening a receipt", async () => {
  paid = true;
  refunds = [
    {
      id,
      paymentId: id,
      amountCents: 500,
      status: "reconciliation",
      reason: "Customer request",
      createdAt: "2026-03-09T12:00:00.000Z",
    },
  ];
  renderApp(<CheckoutPanel id={id} mode="admin" role="owner" />);
  await screen.findByText(
    "The bank result is uncertain. Check the bank portal and reconcile it before retrying.",
  );
  expect(screen.getByLabelText("Bank confirmation reference")).toBeInTheDocument();
});

test("clearing the amount does not silently charge the full balance", async () => {
  renderApp(<CheckoutPanel id={id} mode="admin" role="owner" />);
  await screen.findByText("Haircut");
  const input = await screen.findByLabelText("Amount");
  fireEvent.change(input, { target: { value: "" } });
  expect(input).toHaveValue("");
  fireEvent.click(screen.getByRole("button", { name: "Record payment" }));
  await screen.findByText("Enter an amount greater than zero and no more than the balance due.");
  expect(requests.filter((request) => request.method === "POST")).toHaveLength(0);
});

test("only an owner is offered bank reconciliation for a stale pending attempt", async () => {
  payments = [
    {
      id,
      method: "redsys_card",
      amountCents: 2500,
      status: "pending",
      order: "1234567890",
      createdAt: "2026-03-09T12:00:00.000Z",
      reconcileAfter: "2026-03-09T12:01:00.000Z",
    },
  ];
  renderApp(<CheckoutPanel id={id} mode="admin" role="owner" />);
  await screen.findByLabelText("Bank confirmation reference");
  expect(screen.queryByRole("button", { name: "Record payment" })).toBeNull();
});
test("an unpaid receipt offers an explicit void action", async () => {
  renderApp(<CheckoutPanel id={id} mode="admin" role="owner" />);
  await screen.findByText("Haircut");
  fireEvent.click(screen.getByText("Void unpaid checkout", { selector: "summary" }));
  expect(screen.getByRole("button", { name: "Void unpaid checkout" })).toBeInTheDocument();
});
test("a client can select gift tender when online banking is disabled and sends its code in the body", async () => {
  giftAvailable = true;
  renderApp(<CheckoutPanel id={id} mode="client" role="client" />);
  await screen.findByText("Haircut");
  fireEvent.change(await screen.findByLabelText("Gift card code"), {
    target: { value: "SOB-ABCD-1234-ABCD-1234-ABCD-1234" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Redeem gift card" }));
  await screen.findByText("Paid", { selector: "p" });
  const posted = requests.filter((request) => request.method === "POST");
  expect(posted).toHaveLength(1);
  expect(posted[0]?.body).toMatchObject({
    method: "gift_card",
    giftCardCode: "SOBABCD1234ABCD1234ABCD1234",
    amountCents: 2500,
  });
});
test("a client can explicitly cancel an unpaid pass purchase without a manual payment capability", async () => {
  const fallback = globalThis.fetch;
  let voided = false;
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path.endsWith(`/checkouts/${id}/void`)) {
      voided = true;
      return reply({ ...sale(), status: "void", balanceCents: 0 });
    }
    if (path.endsWith(`/checkouts/${id}`))
      return reply({
        ...sale(),
        clientId: id,
        status: voided ? "void" : "open",
        balanceCents: voided ? 0 : 2500,
        lines: [
          {
            id,
            kind: "membership_period",
            passPeriodId: id,
            description: "Monthly visits",
            quantity: 1,
            unitAmountCents: 2500,
            taxBasisPoints: 0,
          },
        ],
      });
    return fallback(input, init);
  }) as unknown as typeof fetch;
  renderApp(<CheckoutPanel id={id} mode="client" role="client" />);
  await screen.findByText("Monthly visits");
  fireEvent.click(screen.getByText("Cancel unpaid purchase", { selector: "summary" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel unpaid purchase" }));
  await waitFor(() => expect(voided).toBe(true));
  await screen.findByText("Voided");
  expect(screen.queryByRole("button", { name: "Continue to secure payment" })).toBeNull();
});
