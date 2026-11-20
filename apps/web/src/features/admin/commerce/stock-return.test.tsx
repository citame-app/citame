import { afterEach, expect, test } from "bun:test";
import type { Checkout, StockReturnInput } from "@sob/contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { StockReturn } from "./stock-return";

const userId = "desk-owner";
const checkoutId = "0198f5a0-7b1c-7000-8000-000000000101";
const lineId = "0198f5a0-7b1c-7000-8000-000000000102";
const productId = "0198f5a0-7b1c-7000-8000-000000000103";
const storageKey = `citame:stock-return:${userId}:${checkoutId}`;
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  sessionStorage.removeItem(storageKey);
});

const checkout = (generation: string): Checkout => ({
  id: checkoutId,
  appointmentId: null,
  clientId: null,
  stockReturnGeneration: generation,
  status: "paid",
  currency: "EUR",
  subtotalCents: 2000,
  discountCents: 0,
  tipCents: 0,
  taxCents: 0,
  totalCents: 2000,
  paidCents: 2000,
  refundedCents: 0,
  balanceCents: 0,
  overpaidCents: 0,
  payments: [],
  refunds: [],
  fulfilledAt: "2026-03-09T12:00:00Z",
  createdAt: "2026-03-09T12:00:00Z",
  lines: [
    {
      id: lineId,
      productId,
      kind: "product",
      description: "Shampoo",
      quantity: 2,
      unitAmountCents: 1000,
      taxBasisPoints: 0,
    },
  ],
});
const mockRequests = (requests: StockReturnInput[], lostFirstResponse: boolean) => {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path === "/api/me")
      return Response.json({
        user: { id: userId, name: "Owner", email: "owner@example.test", role: "owner" },
        staffId: null,
        clientId: null,
        phone: null,
      });
    if (path !== "/api/admin/inventory/returns") return new Response(null, { status: 404 });
    requests.push(JSON.parse(String(init?.body)));
    if (lostFirstResponse && requests.length === 1) throw new Error("lost response");
    return Response.json({
      id: productId,
      name: "Shampoo",
      sku: "SHAMP",
      barcode: null,
      description: null,
      priceCents: 1000,
      currency: "EUR",
      taxBasisPoints: 0,
      unitLabel: "unit",
      stockOnHand: 3,
      stockReserved: 0,
      available: 3,
      active: true,
      version: 7,
      lowStockThreshold: 0,
      lowStock: false,
      storageLocation: null,
      canManage: true,
      createdAt: "2026-03-09T12:00:00Z",
      updatedAt: "2026-03-09T12:00:00Z",
    });
  }) as typeof fetch;
};

test("reopening a receipt verifies the same stock return after a lost response", async () => {
  const requests: StockReturnInput[] = [];
  mockRequests(requests, true);
  const first = renderApp(<StockReturn checkout={checkout("initial")} />);
  fireEvent.click(screen.getByText("Return product to stock", { selector: "summary" }));
  fireEvent.change(await screen.findByLabelText("Reason"), { target: { value: "Unopened item" } });
  fireEvent.click(screen.getByRole("button", { name: "Return product to stock" }));
  await screen.findByRole("alert");
  first.unmount();

  renderApp(<StockReturn checkout={checkout("initial")} />);
  fireEvent.click(screen.getByText("Return product to stock", { selector: "summary" }));
  fireEvent.click(await screen.findByRole("button", { name: "Retry the same movement" }));
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[1]).toMatchObject({ generation: "initial", actorUserId: userId, quantity: 1 });
  await screen.findByText("Product returned to stock");
  expect(sessionStorage.getItem(storageKey)).toBeNull();
});

test("a previous-generation return remains reviewable after restore without resubmitting", async () => {
  const requests: StockReturnInput[] = [];
  mockRequests(requests, false);
  sessionStorage.setItem(
    storageKey,
    JSON.stringify({
      checkoutLineId: lineId,
      actorUserId: userId,
      quantity: 1,
      reason: "Unopened item",
      generation: "initial",
      idempotencyKey: crypto.randomUUID(),
    }),
  );
  renderApp(<StockReturn checkout={checkout("restored")} />);
  fireEvent.click(screen.getByText("Return product to stock", { selector: "summary" }));
  const discard = await screen.findByRole("button", { name: "Discard previous request" });
  expect(screen.getByLabelText("Reason")).toHaveValue("Unopened item");
  fireEvent.click(discard);
  expect(requests).toHaveLength(0);
  expect(sessionStorage.getItem(storageKey)).toBeNull();
});
