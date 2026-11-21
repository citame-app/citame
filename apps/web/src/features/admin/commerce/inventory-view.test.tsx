import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { InventoryView } from "./inventory-view";

const realFetch = globalThis.fetch;
const id = "0198f5a0-7b1c-7000-8000-000000000100";
let calls: Record<string, unknown>[];
let queries: URLSearchParams[];
let productTotal: number;
let detailProduct: typeof product;
let stockError: "sync_generation_changed" | undefined;
let valuation: { currency: "EUR"; knownCostCents: string; productsMissingCost: number } | undefined;
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
  packageContent: { quantity: "150", unit: "ml" },
  storageLocation: "Cabinet 2",
  active: true,
  stockOnHand: 5,
  stockReserved: 2,
  available: 3,
  lowStockThreshold: 3,
  lowStock: true,
  version: 4,
  inventoryGeneration: "reviewed-stock",
  createdAt: "2026-03-09T12:00:00.000Z",
  updatedAt: "2026-03-09T12:00:00.000Z",
};
beforeEach(() => {
  calls = [];
  queries = [];
  productTotal = 1;
  detailProduct = product;
  stockError = undefined;
  valuation = undefined;
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const { pathname: path, searchParams } = url;
    if (init?.method === "POST" || init?.method === "PATCH") {
      calls.push(JSON.parse(String(init.body)));
      if (path.endsWith("/movements") && stockError) {
        return Response.json({ error: { code: stockError, message: stockError } }, { status: 409 });
      }
      return Response.json(path.endsWith("/movements") ? { ...product, version: 5 } : product);
    }
    if (path.endsWith("/facets")) return Response.json({ categories: [], brands: [] });
    if (path.endsWith("/receipts"))
      return Response.json({
        generation: detailProduct.inventoryGeneration,
        receipts: [
          {
            id,
            number: 19,
            receivedOn: "2026-03-09",
            supplierId: null,
            supplierName: null,
            invoiceReference: "Reference",
            notes: null,
            lineCount: 1,
            createdAt: "2026-03-09T12:00:00.000Z",
          },
        ],
        pagination: { page: 1, pageSize: 20, total: 1 },
      });
    if (path.endsWith(`/products/${id}`)) return Response.json(detailProduct);
    if (path.endsWith("/movements"))
      return Response.json({
        movements: [],
        pagination: { page: 1, pageSize: 20, total: 0 },
        inventoryGeneration: detailProduct.inventoryGeneration,
      });
    if (path.endsWith("/report"))
      return Response.json({ products: 1, onHand: 5, reserved: 2, lowStockProducts: 1, valuation });
    if (path.endsWith("/products")) queries.push(searchParams);
    return Response.json({
      products: [product],
      pagination: {
        page: Number(searchParams.get("page") ?? 1),
        pageSize: Number(searchParams.get("pageSize") ?? 20),
        total: productTotal,
      },
    });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  window.sessionStorage.clear();
});
test("inventory separates available and reserved stock and staff have no editing controls or costs", async () => {
  renderApp(<InventoryView role="staff" />);
  await screen.findByText("Repair shampoo");
  expect(screen.getByText("Available: 3")).toBeInTheDocument();
  expect(screen.getByText("Reserved: 2")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "New product" })).toBeNull();
  expect(screen.queryByText(/7[.,]00/)).toBeNull();
});

test("inventory readers can inspect receipt history and cannot open the editors", async () => {
  renderApp(<InventoryView role="staff" accessPreset="receptionist" userId="receipt-reader" />);
  fireEvent.click(screen.getByRole("button", { name: /^Stock receipts$/ }));
  expect((await screen.findAllByText("Stock receipt #19")).length).toBeGreaterThan(0);
  expect(screen.queryByRole("button", { name: "New stock receipt" })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Suppliers$/ })).toBeNull();
});

test("reception can inspect a product and its history, then return to the same search", async () => {
  renderApp(<InventoryView role="staff" accessPreset="receptionist" />);
  await screen.findByText("Repair shampoo");
  const search = screen.getByLabelText("Search products");
  fireEvent.change(search, { target: { value: "shampoo" } });
  const view = screen.getByRole("button", { name: "View product Repair shampoo" });
  view.focus();
  fireEvent.click(view);
  const heading = await screen.findByRole("heading", { name: "Repair shampoo", level: 2 });
  expect(heading).toHaveFocus();
  expect(screen.getByText("Cabinet 2")).toBeVisible();
  expect(screen.getByText("150 ml")).toBeVisible();
  expect(screen.getByRole("heading", { name: "Stock history" })).toBeVisible();
  expect(screen.queryByText("Unit cost (EUR)")).toBeNull();
  expect(screen.queryByRole("button", { name: "Save product" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Record stock movement" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Back to inventory" }));
  expect(search).toHaveValue("shampoo");
  expect(view).toHaveFocus();
  expect(calls).toHaveLength(0);
});
test("owner records a stock delivery with a version fence and a reason", async () => {
  renderApp(<InventoryView role="owner" userId="stock-owner" />);
  await screen.findByText("Repair shampoo");
  fireEvent.click(screen.getByRole("button", { name: "Manage product" }));
  fireEvent.change(await screen.findByLabelText("Quantity"), { target: { value: "3" } });
  fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Supplier delivery" } });
  fireEvent.click(screen.getByRole("button", { name: "Record stock movement" }));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]).toMatchObject({
    kind: "receive",
    quantity: 3,
    reason: "Supplier delivery",
    version: 4,
    generation: "reviewed-stock",
    actorUserId: "stock-owner",
  });
  expect(calls[0]?.idempotencyKey).toEqual(expect.any(String));
});

test("a live inventory refresh preserves an open draft until the operator reviews it", async () => {
  const { queryClient } = renderApp(<InventoryView role="owner" />);
  fireEvent.click(await screen.findByRole("button", { name: "Manage product" }));
  const name = await screen.findByLabelText("Product name");
  fireEvent.change(name, { target: { value: "Unsaved local name" } });
  await waitFor(() =>
    expect(queryClient.isFetching({ queryKey: ["inventory", "product", id] })).toBe(0),
  );
  detailProduct = { ...product, version: 5, name: "Published from Desktop" };
  // Apply the refreshed detail as the query cache would after a commerce event.
  act(() => {
    queryClient.setQueriesData({ queryKey: ["inventory", "product", id] }, detailProduct);
  });
  expect(name).toHaveValue("Unsaved local name");
  const review = await screen.findByText("Discard drafts and load latest details", { exact: true });
  expect(screen.getByText("Save product", { exact: true })).toBeDisabled();
  fireEvent.click(review);
  expect(await screen.findByLabelText("Product name")).toHaveValue("Published from Desktop");
  expect(calls).toHaveLength(0);
});

test("a restore keeps the pending adjustment through stock review and protects a catalog draft", async () => {
  stockError = "sync_generation_changed";
  renderApp(<InventoryView role="owner" userId="stock-owner" />);
  fireEvent.click(await screen.findByRole("button", { name: "Manage product" }));
  fireEvent.change(await screen.findByLabelText("Product name"), {
    target: { value: "Unsaved name" },
  });
  fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "3" } });
  fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Supplier delivery" } });
  fireEvent.click(screen.getByRole("button", { name: "Record stock movement" }));

  const load = await screen.findByRole("button", { name: "Load current stock" });
  const key = `citame:stock:stock-owner:${id}`;
  const original = window.sessionStorage.getItem(key);
  expect(JSON.parse(original ?? "null")).toMatchObject({
    generation: "reviewed-stock",
    quantity: 3,
  });
  detailProduct = { ...product, inventoryGeneration: "restored-stock", stockOnHand: 9 };
  fireEvent.click(load);
  await screen.findByRole("heading", { name: "Current stock and recent movements" });
  expect(window.sessionStorage.getItem(key)).toBe(original);
  expect(screen.getByLabelText("Product name")).toHaveValue("Unsaved name");
  fireEvent.click(screen.getByRole("button", { name: "Discard previous request" }));
  expect(window.sessionStorage.getItem(key)).toBeNull();
  expect(screen.getByLabelText("Product name")).toHaveValue("Unsaved name");
  expect(calls).toHaveLength(1);
});

test("a reopened editor can retry the exact command after an earlier view acknowledges it", async () => {
  const key = `citame:stock:stock-owner:${id}`;
  const command = {
    kind: "receive",
    quantity: 3,
    reason: "Supplier delivery",
    version: 3,
    generation: "reviewed-stock",
    idempotencyKey: "stock-lost-ack",
    actorUserId: "stock-owner",
  };
  window.sessionStorage.setItem(key, JSON.stringify(command));
  renderApp(<InventoryView role="owner" userId="stock-owner" />);
  fireEvent.click(await screen.findByRole("button", { name: "Manage product" }));
  const retry = await screen.findByRole("button", { name: "Retry the same movement" });
  window.sessionStorage.removeItem(key);
  fireEvent.click(retry);
  await waitFor(() => expect(calls).toEqual([command]));
});

test("package content accepts a decimal comma and requires a unit before saving", async () => {
  detailProduct = { ...product, version: 5, packageContent: { quantity: "250", unit: "ml" } };
  renderApp(<InventoryView role="owner" />);
  await screen.findByText("Repair shampoo");
  fireEvent.click(screen.getByRole("button", { name: "Manage product" }));
  const quantity = await screen.findByLabelText("Quantity per pack");
  const unit = screen.getByLabelText("Pack content unit");
  expect(quantity).toHaveValue("250");
  fireEvent.change(quantity, { target: { value: "12,5" } });
  fireEvent.change(unit, { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Save product" }));
  expect(unit).toHaveFocus();
  expect(unit).toHaveAttribute("aria-invalid", "true");
  expect(calls).toHaveLength(0);
  fireEvent.change(unit, { target: { value: "ml" } });
  fireEvent.click(screen.getByRole("button", { name: "Save product" }));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]).toMatchObject({ version: 5, packageContent: { quantity: "12.5", unit: "ml" } });
  expect(calls[0]).not.toHaveProperty("openingStock");
});

test("the stock CSV applies the visible filters without limiting export to the current page", async () => {
  valuation = { currency: "EUR", knownCostCents: "900719925474099199", productsMissingCost: 1 };
  renderApp(<InventoryView role="owner" />);
  expect(await screen.findByText("€9,007,199,254,740,991.99")).toBeInTheDocument();
  expect(screen.getByText("Products in stock without a recorded cost: 1")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox", { name: "Show only low stock" }));
  fireEvent.change(screen.getByLabelText("Search products"), { target: { value: "shampoo" } });
  await waitFor(() => {
    const exportLink = screen.getByRole("link", { name: "Download stock CSV" });
    const url = new URL(exportLink.getAttribute("href") ?? "", "https://example.test");
    expect(url.pathname).toBe("/api/admin/inventory/products/export");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      search: "shampoo",
      active: "active",
      lowStock: "true",
      sort: "name_asc",
    });
  });
});

test("the movements CSV uses the ledger's search and selected movement type", async () => {
  const view = renderApp(<InventoryView role="staff" />);
  fireEvent.click(screen.getByRole("button", { name: "Stock movements" }));
  fireEvent.change(screen.getByLabelText("Search movements"), { target: { value: "delivery" } });
  fireEvent.change(screen.getByLabelText("Stock movement"), { target: { value: "receive" } });
  await waitFor(() => {
    const link = screen.getByRole("link", { name: "Download movements CSV" });
    const url = new URL(link.getAttribute("href") ?? "", "https://example.test");
    expect(url.pathname).toBe("/api/admin/inventory/movements/export");
    expect(Object.fromEntries(url.searchParams)).toEqual({ search: "delivery", kind: "receive" });
  });
  await screen.findByText("No stock movements match this selection.");
  view.unmount();
});

test("the catalog resets pagination when the sort or page size changes", async () => {
  productTotal = 123;
  renderApp(<InventoryView role="owner" />);
  await screen.findByText("Page 1 of 7");
  const next = screen.getByRole("button", { name: "Next page" });
  fireEvent.click(next);
  await waitFor(() => expect(queries.at(-1)?.get("page")).toBe("2"));
  const sort = screen.getByLabelText("Sort by");
  sort.focus();
  fireEvent.change(sort, { target: { value: "updated_desc" } });
  await waitFor(() =>
    expect(Object.fromEntries(queries.at(-1) ?? [])).toMatchObject({
      sort: "updated_desc",
      page: "1",
    }),
  );
  expect(sort).toHaveFocus();
  await screen.findByText("Sorted by Last updated. Total results 123.");
  await waitFor(() => expect(next).toBeEnabled());
  fireEvent.click(next);
  await waitFor(() => expect(queries.at(-1)?.get("page")).toBe("2"));
  fireEvent.change(screen.getByLabelText("Products per page"), { target: { value: "50" } });
  await screen.findByText("Page 1 of 3");
  await waitFor(() =>
    expect(Object.fromEntries(queries.at(-1) ?? [])).toMatchObject({
      sort: "updated_desc",
      page: "1",
      pageSize: "50",
    }),
  );
  const csv = new URL(
    screen.getByRole("link", { name: "Download stock CSV" }).getAttribute("href")!,
    "https://example.test",
  );
  expect(csv.searchParams.get("sort")).toBe("updated_desc");
  expect(csv.searchParams.has("page")).toBe(false);
  expect(csv.searchParams.has("pageSize")).toBe(false);
});
