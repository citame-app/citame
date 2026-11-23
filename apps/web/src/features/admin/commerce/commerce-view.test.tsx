import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { CommerceView } from "./commerce-view";
import { PointOfSale } from "./point-of-sale";

const realFetch = globalThis.fetch;
const id = "0198f5a0-7b1c-7000-8000-000000000100";
let calls: { path: string; body: Record<string, unknown> }[];
let cash: null | Record<string, unknown>;
const receiptId = "0198f5a0-7b1c-7000-8000-000000000101";
let dueReceipt:
  | {
      id: string;
      confirmedCents: number;
      balanceCents: number | null;
      paymentInProgress: boolean;
      pricePending: boolean;
    }
  | undefined;
let externalBalance: { paidInBooksyCents: number; dueInCitameCents: number } | undefined;
beforeEach(() => {
  cash = null;
  externalBalance = undefined;
  dueReceipt = undefined;
  calls = [];
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (init?.method === "POST") calls.push({ path, body });
    if (path.endsWith("/unpaid")) {
      const startsAt = "2026-03-09T12:00:00.000Z";
      return Response.json({
        appointments: [
          {
            id,
            clientId: id,
            staffId: id,
            startsAt,
            endsAt: "2026-03-09T12:30:00.000Z",
            createdAt: startsAt,
            updatedAt: startsAt,
            status: "completed",
            notes: null,
            version: 1,
            services: [],
            serviceNames: ["Catalog treatment"],
            clientName: "Test customer",
            externalBalance,
            receiptBalance: dueReceipt,
          },
        ],
      });
    }
    if (path.endsWith("/admin/staff"))
      return Response.json({
        staff: [{ id, displayName: "Ana", active: true, userId: null, serviceIds: [] }],
      });
    if (path === "/api/services")
      return Response.json({
        services: [
          {
            id,
            name: "Catalog treatment",
            description: null,
            durationMinutes: 30,
            bufferMinutes: 0,
            priceCents: 2500,
            currency: "EUR",
          },
        ],
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
        id: body.sessionId,
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
      if (body.reviewedExpectedCents !== cash?.expectedCents) {
        return Response.json(
          { error: { code: "version_conflict", message: "Cash movements changed" } },
          { status: 409 },
        );
      }
      cash = {
        ...cash,
        countedCents: body.countedCents,
        differenceCents: Number(body.countedCents) - Number(cash?.expectedCents),
        closedAt: "2026-03-09T18:00:00.000Z",
      };
      return Response.json(cash);
    }
    if (path.endsWith("/checkouts") && init?.method !== "POST")
      return Response.json({ checkouts: [], total: 0, page: 1, pageSize: 25 });
    if (path.endsWith("/checkouts") && body.appointmentId) {
      if (externalBalance && body.useClientDiscount) {
        return Response.json(
          {
            error: {
              code: "validation_error",
              message: "The verified balance cannot be discounted",
            },
          },
          { status: 400 },
        );
      }
      const totalCents = externalBalance?.dueInCitameCents ?? 2500;
      return Response.json({
        id,
        appointmentId: id,
        clientId: id,
        currency: "EUR",
        status: "open",
        subtotalCents: totalCents,
        discountCents: 0,
        tipCents: 0,
        taxCents: 0,
        totalCents,
        paidCents: 0,
        refundedCents: 0,
        balanceCents: totalCents,
        lines: [],
        payments: [],
        refunds: [],
        externalBalance,
        createdAt: "2026-03-09T12:00:00.000Z",
      });
    }
    return Response.json({});
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test.each([false, true])(
  "opens the right checkout for a verified Booksy balance (%s)",
  async (partial) => {
    if (partial) externalBalance = { paidInBooksyCents: 3500, dueInCitameCents: 6500 };
    const onCreated = mock(() => {});
    renderApp(<PointOfSale role="owner" sales={[]} onCreated={onCreated} onBenefits={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "To collect" }));
    fireEvent.click(
      await screen.findByRole("button", { name: partial ? "Collect €65" : "Collect payment" }),
    );
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toMatchObject({ appointmentId: id, lines: [], discountCents: 0 });
    if (partial) expect(calls[0]?.body).not.toHaveProperty("useClientDiscount");
    else expect(calls[0]?.body.useClientDiscount).toBe(true);
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(id));
  },
);
test("the unpaid desk identifies the existing receipt and its confirmed balance without another create", async () => {
  dueReceipt = {
    id: receiptId,
    confirmedCents: 2400,
    balanceCents: 1600,
    paymentInProgress: false,
    pricePending: false,
  };
  const onCreated = mock(() => {});
  renderApp(<PointOfSale role="owner" sales={[]} onCreated={onCreated} onBenefits={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "To collect" }));
  expect(await screen.findByText("Confirmed payments")).toBeVisible();
  expect(screen.getByText("€24")).toBeVisible();
  expect(screen.getByText("Remaining on receipt")).toBeVisible();
  expect(screen.getByText("€16")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Open receipt" }));
  expect(onCreated).toHaveBeenCalledWith(receiptId);
  expect(calls).toHaveLength(0);
});

test("a payment to verify shows its status without a collectible amount", async () => {
  dueReceipt = {
    id: receiptId,
    confirmedCents: 2400,
    balanceCents: null,
    paymentInProgress: true,
    pricePending: false,
  };
  renderApp(<PointOfSale role="owner" sales={[]} onCreated={() => {}} onBenefits={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "To collect" }));
  expect(await screen.findByText("Payment to verify")).toBeVisible();
  expect(screen.queryByText("Final price pending")).toBeNull();
  expect(screen.queryByText("Remaining on receipt")).toBeNull();
  expect(screen.getByText("€24")).toBeVisible();
});

test("owner can open and close the register with a counted discrepancy", async () => {
  renderApp(<CommerceView role="owner" />);
  await screen.findByText("Your basket is empty");
  fireEvent.click(screen.getByRole("button", { name: "Cash registers" }));
  fireEvent.change(await screen.findByLabelText("Opening cash"), { target: { value: "50.00" } });
  fireEvent.click(screen.getByRole("button", { name: "Open register" }));
  await screen.findByText("The cash register is open");
  expect(calls[0]?.body).toEqual({ openingCents: 5000, sessionId: expect.any(String) });
  fireEvent.change(screen.getByLabelText("Counted cash"), { target: { value: "49.50" } });
  fireEvent.click(screen.getByRole("button", { name: "Close and reconcile" }));
  await screen.findByText("Difference");
  expect(calls[1]?.body).toEqual({ countedCents: 4950, reviewedExpectedCents: 5000 });
});

test("a concurrent cash movement clears the stale count and asks for a fresh count", async () => {
  renderApp(<CommerceView role="owner" />);
  fireEvent.click(screen.getByRole("button", { name: "Cash registers" }));
  fireEvent.change(await screen.findByLabelText("Opening cash"), { target: { value: "50.00" } });
  fireEvent.click(screen.getByRole("button", { name: "Open register" }));
  const field = await screen.findByLabelText("Counted cash");
  fireEvent.change(field, { target: { value: "50.00" } });
  cash = { ...cash, expectedCents: 6000 };
  fireEvent.click(screen.getByRole("button", { name: "Close and reconcile" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The expected cash changed. Review the balance and count the cash again.",
  );
  expect(field).toHaveValue("");
  await waitFor(() => expect(field).toBeEnabled());
  fireEvent.change(field, { target: { value: "60.00" } });
  fireEvent.click(screen.getByRole("button", { name: "Close and reconcile" }));
  await screen.findByText("Difference");
  expect(calls[1]?.body).toEqual({ countedCents: 5000, reviewedExpectedCents: 5000 });
  expect(calls[2]?.body).toEqual({ countedCents: 6000, reviewedExpectedCents: 6000 });
});
test("staff can reach sales but do not see owner-only register controls", async () => {
  renderApp(<CommerceView role="staff" />);
  await screen.findByText("Your basket is empty");
  expect(screen.queryByRole("button", { name: "Open register" })).toBeNull();
  expect(screen.getByRole("button", { name: "New sale" })).toBeInTheDocument();
});
test("invalid cash input explains the error without sending a mutation", async () => {
  renderApp(<CommerceView role="owner" />);
  fireEvent.click(screen.getByRole("button", { name: "Cash registers" }));
  await screen.findByText("The cash register is closed");
  fireEvent.change(screen.getByLabelText("Opening cash"), { target: { value: "-5" } });
  fireEvent.click(screen.getByRole("button", { name: "Open register" }));
  await screen.findByRole("alert");
  expect(calls).toHaveLength(0);
});
test("retail checkout uses catalog ids and quantities without browser-supplied prices", async () => {
  renderApp(<CommerceView role="owner" />);
  await screen.findByText("Your basket is empty");
  fireEvent.click(screen.getByRole("button", { name: "Products" }));
  fireEvent.click(await screen.findByRole("button", { name: /Retail shampoo/ }));
  fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "2" } });
  fireEvent.click(screen.getByRole("button", { name: "Select payment method" }));
  await screen.findByRole("alert");
  expect(calls[0]?.body.lines).toEqual([
    { kind: "product", productId: id, quantity: 2, taxBasisPoints: 0 },
  ]);
});
test("owner can attribute a retail or custom sale to a professional", async () => {
  renderApp(<CommerceView role="owner" />);
  await screen.findByText("Your basket is empty");
  fireEvent.click(screen.getByRole("button", { name: "New sale" }));
  fireEvent.change(await screen.findByLabelText("Professional"), { target: { value: id } });
  fireEvent.click(screen.getByRole("button", { name: "Custom amount" }));
  fireEvent.change(screen.getByLabelText("Item or service"), { target: { value: "Custom item" } });
  fireEvent.change(screen.getByLabelText("Amount (EUR)"), { target: { value: "20" } });
  fireEvent.click(screen.getByRole("button", { name: "Add to receipt" }));
  fireEvent.click(screen.getByRole("button", { name: "Select payment method" }));
  await screen.findByRole("alert");
  expect(calls[0]?.body.staffId).toBe(id);
});
test("opening rewards and returning to sales preserves a valid render lifecycle", async () => {
  renderApp(<CommerceView role="owner" />);
  await screen.findByText("Your basket is empty");
  fireEvent.click(screen.getByRole("button", { name: "Gift cards & rewards" }));
  await screen.findByRole("heading", { name: "Gift cards", level: 2 });
  fireEvent.click(screen.getByRole("button", { name: "Back to sales" }));
  await screen.findByText("Your basket is empty");
});

test("catalog selection stays local until payment review and preserves the basket between sections", async () => {
  renderApp(<CommerceView role="owner" />);
  fireEvent.click(await screen.findByRole("button", { name: /Catalog treatment/ }));
  expect(calls).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Inventory" }));
  await screen.findByRole("heading", { name: "Inventory" });
  fireEvent.click(screen.getByRole("button", { name: "Back to sales" }));
  const receipt = screen.getByRole("complementary", { name: "Current receipt" });
  expect(within(receipt).getByText("Catalog treatment")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Select payment method" }));
  await screen.findByRole("alert");
  expect(calls[0]?.body.lines).toEqual([
    { kind: "service", serviceId: id, quantity: 1, taxBasisPoints: 0 },
  ]);
  expect(calls[0]?.body).not.toHaveProperty("appointmentId");
});
