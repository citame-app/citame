import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { fireEvent, screen } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { CommerceView } from "./commerce-view";

const realFetch = globalThis.fetch;
const id = "0198f5a0-7b1c-7000-8000-000000000100";
let calls: { path: string; body: Record<string, unknown> }[];
let cash: null | Record<string, unknown>;
beforeEach(() => {
  cash = null;
  calls = [];
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (init?.method === "POST") calls.push({ path, body });
    if (path.endsWith("/admin/staff"))
      return Response.json({
        staff: [{ id, displayName: "Ana", active: true, userId: null, serviceIds: [] }],
      });
    if (path.endsWith("/inventory/products"))
      return Response.json({
        products: [
          {
            id,
            name: "Retail shampoo",
            sku: "SH-1",
            barcode: null,
            description: null,
            priceCents: 2000,
            currency: "EUR",
            taxBasisPoints: 2100,
            unitLabel: "unit",
            storageLocation: null,
            active: true,
            stockOnHand: 5,
            stockReserved: 0,
            available: 5,
            lowStockThreshold: 0,
            lowStock: false,
            version: 1,
            createdAt: "2026-03-09T12:00:00.000Z",
            updatedAt: "2026-03-09T12:00:00.000Z",
          },
        ],
        pagination: { page: 1, pageSize: 20, total: 1 },
      });
    if (path.endsWith("/cash-sessions/current")) return Response.json({ session: cash });
    if (path.endsWith("/cash-sessions") && init?.method === "POST") {
      cash = {
        id,
        openingCents: body.openingCents,
        expectedCents: body.openingCents,
        countedCents: null,
        differenceCents: null,
        openedAt: "2026-03-09T12:00:00.000Z",
        closedAt: null,
        movements: [],
      };
      return Response.json(cash);
    }
    if (path.endsWith("/close")) {
      cash = {
        ...cash,
        countedCents: body.countedCents,
        differenceCents: Number(body.countedCents) - Number(cash?.expectedCents),
        closedAt: "2026-03-09T18:00:00.000Z",
      };
      return Response.json(cash);
    }
    if (path.endsWith("/checkouts") && init?.method !== "POST")
      return Response.json({ checkouts: [] });
    return Response.json({});
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});
test("owner can open and close the register with a counted discrepancy", async () => {
  renderApp(<CommerceView role="owner" />);
  await screen.findByText("No sales yet");
  fireEvent.change(screen.getByLabelText("Opening cash"), { target: { value: "50.00" } });
  fireEvent.click(screen.getByRole("button", { name: "Open register" }));
  await screen.findByText("The cash register is open");
  expect(calls[0]?.body).toEqual({ openingCents: 5000 });
  fireEvent.change(screen.getByLabelText("Counted cash"), { target: { value: "49.50" } });
  fireEvent.click(screen.getByRole("button", { name: "Close and reconcile" }));
  await screen.findByText("Difference");
  expect(calls[1]?.body).toEqual({ countedCents: 4950 });
});
test("staff can reach sales but do not see owner-only register controls", async () => {
  renderApp(<CommerceView role="staff" />);
  await screen.findByText("No sales yet");
  expect(screen.queryByRole("button", { name: "Open register" })).toBeNull();
  expect(screen.getByRole("button", { name: "New sale" })).toBeInTheDocument();
});
test("invalid cash input explains the error without sending a mutation", async () => {
  renderApp(<CommerceView role="owner" />);
  await screen.findByText("The cash register is closed");
  fireEvent.change(screen.getByLabelText("Opening cash"), { target: { value: "-5" } });
  fireEvent.click(screen.getByRole("button", { name: "Open register" }));
  await screen.findByRole("alert");
  expect(calls).toHaveLength(0);
});
test("retail checkout uses catalog ids and quantities without browser-supplied prices", async () => {
  renderApp(<CommerceView role="owner" />);
  await screen.findByText("No sales yet");
  fireEvent.click(screen.getByRole("button", { name: "New sale" }));
  await screen.findByLabelText("Choose a product");
  fireEvent.change(screen.getByLabelText("Choose a product"), { target: { value: id } });
  fireEvent.click(screen.getByRole("button", { name: "Add product" }));
  fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "2" } });
  fireEvent.click(screen.getByRole("button", { name: "Create checkout" }));
  await screen.findByRole("alert");
  expect(calls[0]?.body.lines).toEqual([
    { kind: "product", productId: id, quantity: 2, taxBasisPoints: 0 },
  ]);
});
test("owner can attribute a retail or custom sale to a professional", async () => {
  renderApp(<CommerceView role="owner" />);
  await screen.findByText("No sales yet");
  fireEvent.click(screen.getByRole("button", { name: "New sale" }));
  fireEvent.change(await screen.findByLabelText("Professional"), { target: { value: id } });
  fireEvent.change(screen.getByLabelText("Item or service"), { target: { value: "Custom item" } });
  fireEvent.change(screen.getByLabelText("Price (EUR)"), { target: { value: "20" } });
  fireEvent.click(screen.getByRole("button", { name: "Create checkout" }));
  await screen.findByRole("alert");
  expect(calls[0]?.body.staffId).toBe(id);
});
