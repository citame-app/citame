import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { InventoryView } from "./inventory-view";

const realFetch = globalThis.fetch;
const id = "0198f5a0-7b1c-7000-8000-000000000100";
let calls: Record<string, unknown>[];
const product = {
  id,
  name: "Repair shampoo",
  sku: "SHAMPOO",
  barcode: null,
  description: null,
  priceCents: 2000,
  currency: "EUR",
  costCents: 700,
  taxBasisPoints: 2100,
  unitLabel: "unit",
  storageLocation: null,
  active: true,
  stockOnHand: 5,
  stockReserved: 2,
  available: 3,
  lowStockThreshold: 3,
  lowStock: true,
  version: 4,
  createdAt: "2026-03-09T12:00:00.000Z",
  updatedAt: "2026-03-09T12:00:00.000Z",
};
beforeEach(() => {
  calls = [];
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (init?.method === "POST") {
      calls.push(JSON.parse(String(init.body)));
      return Response.json(product);
    }
    if (path.endsWith("/movements"))
      return Response.json({ movements: [], pagination: { page: 1, pageSize: 20, total: 0 } });
    return Response.json({ products: [product], pagination: { page: 1, pageSize: 20, total: 1 } });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});
test("inventory separates available and reserved stock and staff have no editing controls or costs", async () => {
  renderApp(<InventoryView role="staff" />);
  await screen.findByText("Repair shampoo");
  expect(screen.getByText("Available: 3")).toBeInTheDocument();
  expect(screen.getByText("Reserved: 2")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "New product" })).toBeNull();
  expect(screen.queryByText(/7[.,]00/)).toBeNull();
});
test("owner records a stock delivery with a version fence and a reason", async () => {
  renderApp(<InventoryView role="owner" />);
  await screen.findByText("Repair shampoo");
  fireEvent.click(screen.getByRole("button", { name: "Manage product" }));
  fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "3" } });
  fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Supplier delivery" } });
  fireEvent.click(screen.getByRole("button", { name: "Record stock movement" }));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]).toMatchObject({
    kind: "receive",
    quantity: 3,
    reason: "Supplier delivery",
    version: 4,
  });
  expect(calls[0]?.idempotencyKey).toEqual(expect.any(String));
});
