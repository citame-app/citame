import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { AccountingView, CommissionPanel, SalesReport } from "./accounting-view";

const realFetch = globalThis.fetch;
const id = "0198f5a0-7b1c-7000-8000-000000000100";
let posts: Record<string, unknown>[];
let salesQueries: URLSearchParams[];
beforeEach(() => {
  posts = [];
  salesQueries = [];
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const path = url.pathname;
    if (path === "/api/admin/staff")
      return Response.json({
        staff: [{ id, displayName: "Ana", active: true, userId: null, serviceIds: [] }],
      });
    if (path === "/api/admin/accounting/sales") {
      salesQueries.push(url.searchParams);
      return Response.json({
        from: url.searchParams.get("from"),
        to: url.searchParams.get("to"),
        timezone: "Europe/Madrid",
        collectedCents: 1800,
        refundedCents: 0,
        netCollectedCents: 1800,
        soldCents: 1800,
        includedTaxCents: 172,
        tipsCents: 0,
        productCostCents: 100,
        unknownCostLines: 0,
        methods: [],
        cashSessions: [],
        settledByFamily: [
          { family: "service", amountCents: 1700, taxCents: 172 },
          { family: "unallocated", amountCents: 100, taxCents: 0 },
        ],
        promotionCollections: [
          {
            name: "=Current offer",
            code: "OFFER",
            collectedCents: 0,
            refundedCents: 125,
            netCents: -125,
          },
        ],
      });
    }
    if (init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)));
      return Response.json({
        id,
        staffId: id,
        amountCents: 1000,
        reference: "Transfer reference 123",
        createdAt: "2026-03-09T12:00:00.000Z",
      });
    }
    if (path.endsWith("/policy"))
      return Response.json({
        staffId: id,
        serviceBasisPoints: 2500,
        productBasisPoints: 1000,
        version: 1,
      });
    return Response.json({
      staffId: id,
      earnedCents: 2250,
      paidCents: 0,
      outstandingCents: 2250,
      accruals: [
        {
          id,
          checkoutId: id,
          description: "Haircut",
          kind: "service",
          basisCents: 9000,
          rateBasisPoints: 2500,
          originalCents: 2250,
          adjustedCents: 2250,
          createdAt: "2026-03-09T12:00:00.000Z",
        },
      ],
      payouts: [],
      pagination: { page: 1, pageSize: 20, total: 1 },
      payoutPagination: { page: 1, pageSize: 20, total: 0 },
    });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});
test("staff can inspect earned commissions without changing rates or recording payouts", async () => {
  renderApp(<CommissionPanel staffId={id} role="staff" />);
  await screen.findByText("Haircut");
  expect(screen.getByText("Outstanding commission")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Save commission rates" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Record completed payout" })).toBeNull();
});
test("owner records an external payout with a reference and stable request key", async () => {
  renderApp(<CommissionPanel staffId={id} role="owner" />);
  await screen.findByText("Haircut");
  fireEvent.change(screen.getByLabelText("Payout amount (EUR)"), { target: { value: "10.00" } });
  fireEvent.change(screen.getByLabelText("Transfer or payment reference"), {
    target: { value: "Transfer reference 123" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Record completed payout" }));
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0]).toMatchObject({ amountCents: 1000, reference: "Transfer reference 123" });
  expect(posts[0]?.idempotencyKey).toEqual(expect.any(String));
});

test("financial reports apply the professional filter and export the visible families", async () => {
  let download: Blob | undefined;
  const create = spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    if (blob instanceof Blob) download = blob;
    return "blob:sales-report";
  });
  const click = spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  try {
    renderApp(<AccountingView role="owner" section="reports" />);
    await screen.findByRole("table", { name: "Settled amounts by sale family" });
    await screen.findByRole("option", { name: "Ana" });
    fireEvent.change(screen.getByLabelText("Professional"), { target: { value: id } });
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    await waitFor(() => expect(salesQueries.at(-1)?.get("staffId")).toBe(id));
    expect(await screen.findByRole("rowheader", { name: "Unallocated" })).toBeInTheDocument();
    const promotions = await screen.findByRole("table", {
      name: "Collections by booking promotion",
    });
    expect(
      within(promotions).getByRole("rowheader", { name: "=Current offer (OFFER)" }),
    ).toBeInTheDocument();
    expect(within(promotions).getByRole("cell", { name: "-€1.25" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Export financial summary (CSV)" }));
    expect(click).toHaveBeenCalledTimes(1);
    expect(await download?.text()).toContain(
      '"sale_family","settled_amount_cents","included_tax_cents","currency"\r\n"service","1700","172","EUR"\r\n"unallocated","100","0","EUR"',
    );
    expect(await download?.text()).toContain(
      `"promotion_name","promotion_code","collected_cents","refunded_cents","net_cents","currency"\r\n"'=Current offer","OFFER","0","125","-125","EUR"`,
    );
  } finally {
    click.mockRestore();
    create.mockRestore();
  }
});

test("a client report rejects a server response with no client scope", async () => {
  renderApp(<SalesReport clientId={id} />);
  await screen.findByRole("alert");
  expect(salesQueries.at(-1)?.get("clientId")).toBe(id);
  expect(screen.queryByRole("table", { name: "Settled amounts by sale family" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Export financial summary (CSV)" })).toBeNull();
});
