import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { PassesView } from "./passes-view";

const realFetch = globalThis.fetch;
const id = "0198f5a0-7b1c-7000-8000-000000000100";
const period = {
  id,
  contractId: id,
  index: 0,
  checkoutId: id,
  status: "active",
  priceCents: 1000,
  startsAt: "2026-11-01T12:00:00.000Z",
  endsAt: null,
  availableUses: 2,
  usedUses: 1,
  heldUses: 0,
  returnedUses: 0,
  remainingAllocationCents: 666,
  version: 2,
};
const pass = {
  id,
  planId: id,
  clientId: id,
  clientName: "Known buyer",
  kind: "package",
  name: "Three visits",
  priceCents: 1000,
  currency: "EUR",
  includedUses: 3,
  discountBasisPoints: 0,
  serviceIds: [id],
  periodMonths: null,
  validityDays: null,
  timezone: "Europe/Madrid",
  status: "active",
  renewalMode: "manual",
  autoPayReady: false,
  cancelAtPeriodEnd: false,
  version: 2,
  periods: [period],
  createdAt: "2026-11-01T12:00:00.000Z",
};
let posts: Record<string, unknown>[];
let membership = false;
let awaitingPayment = false;
beforeEach(() => {
  posts = [];
  membership = false;
  awaitingPayment = false;
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (init?.method === "POST") posts.push(body);
    const current = membership ? { ...pass, kind: "membership", periodMonths: 1 } : pass;
    if (path.endsWith("/capabilities"))
      return Response.json({
        provider: "none",
        environment: null,
        card: false,
        bizum: false,
        giftCards: true,
        currency: "EUR",
      });
    if (path.endsWith("/benefit-plans")) return Response.json({ plans: [] });
    if (path.endsWith(`/passes/${id}`)) return Response.json(current);
    if (path.endsWith("/periods"))
      return Response.json({
        periods: [awaitingPayment ? { ...period, status: "pending", startsAt: null } : period],
        pagination: { page: 1, pageSize: 20, total: 1 },
      });
    if (path.endsWith("/cancel"))
      return Response.json({ ...current, cancelAtPeriodEnd: true, version: 3 });
    return Response.json({ passes: [current], pagination: { page: 1, pageSize: 20, total: 1 } });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});
test("shows available, used and refund-held visits separately", async () => {
  renderApp(<PassesView mode="client" role="client" />);
  await screen.findByText("Three visits");
  expect(screen.getByText("2 available · 1 used · 0 held for refund")).toBeInTheDocument();
});
test("clients see no configured plans and an honest salon-purchase message when online payment is unavailable", async () => {
  renderApp(<PassesView mode="client" role="client" />);
  await screen.findByText("Three visits");
  expect(await screen.findByText(/You can buy or renew at the salon/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Manage plans" })).toBeNull();
});
test("membership cancellation requires an explicit reason and submits the current revision", async () => {
  membership = true;
  renderApp(<PassesView mode="client" role="client" />);
  await screen.findByText("Three visits");
  fireEvent.click(screen.getByRole("button", { name: "View pass" }));
  await screen.findByRole("heading", { name: "Three visits" });
  fireEvent.change(screen.getByLabelText("Cancellation reason"), {
    target: { value: "No longer needed" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Stop renewal" }));
  await waitFor(() => expect(posts).toContainEqual({ version: 2, reason: "No longer needed" }));
});

test("operators can distinguish buyers with the same plan name", async () => {
  renderApp(<PassesView mode="admin" role="owner" />);
  expect(await screen.findByText("Known buyer")).toBeInTheDocument();
});

test("unpaid periods explain activation instead of promising no expiry", async () => {
  awaitingPayment = true;
  renderApp(<PassesView mode="client" role="client" />);
  await screen.findByText("Three visits");
  fireEvent.click(screen.getByRole("button", { name: "View pass" }));
  expect(await screen.findByText("Validity begins after payment.")).toBeInTheDocument();
  expect(screen.queryByText("No expiry date")).toBeNull();
});
