import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { GiftBalanceChecker } from "./gift-balance-checker";
import { GiftCardsView } from "./gift-cards-view";

const realFetch = globalThis.fetch;
const id = "0198f5a0-7b1c-7000-8000-000000000100";
let posts: { path: string; body: Record<string, unknown> }[];
let searched: string[];
const card = {
  id,
  label: "Birthday",
  buyerClientId: null,
  checkoutId: id,
  amountCents: 2000,
  balanceCents: 2000,
  reservedCents: 500,
  availableCents: 1500,
  currency: "EUR",
  status: "active",
  codeLast4: "1234",
  codeRevision: "revision-1",
  expiresAt: null,
  version: 3,
  createdAt: "2026-03-09T12:00:00.000Z",
};
beforeEach(() => {
  posts = [];
  searched = [];
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.pathname.endsWith("/gift-cards")) searched.push(url.searchParams.get("search") ?? "");
    if (init?.method === "POST") posts.push({ path: url.pathname + url.search, body });
    if (url.pathname.endsWith("/check")) return Response.json({ ...card });
    if (url.pathname.endsWith("/capabilities"))
      return Response.json({
        provider: "none",
        environment: null,
        card: false,
        bizum: false,
        giftCards: true,
        currency: "EUR",
      });
    return Response.json({ cards: [card], pagination: { page: 1, pageSize: 20, total: 1 } });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});
test("gift history shows masked codes and distinguishes held from spendable value", async () => {
  renderApp(<GiftCardsView mode="admin" role="owner" />);
  await screen.findByText("Birthday");
  expect(screen.getByText(/1234/)).toBeInTheDocument();
  expect(screen.getByText("Available: €15")).toBeInTheDocument();
  expect(screen.getByText("Reserved: €5")).toBeInTheDocument();
});
test("a bearer checks balance using a POST body rather than a code in the URL", async () => {
  renderApp(<GiftBalanceChecker mode="client" />);
  fireEvent.change(screen.getByLabelText("Gift card code"), {
    target: { value: "SOB-ABCD-1234-ABCD-1234-ABCD-1234" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Check gift balance" }));
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0]).toEqual({
    path: "/api/me/gift-cards/check",
    body: { code: "SOBABCD1234ABCD1234ABCD1234" },
  });
  await screen.findByText("Available: €15");
});

test("search never sends a spendable gift code or a nearly complete code", async () => {
  renderApp(<GiftCardsView mode="admin" role="owner" />);
  await screen.findByText("Birthday");
  const search = screen.getByRole("textbox", { name: /search/i });
  fireEvent.change(search, { target: { value: "SOBABCD1234ABCD1234ABCD123" } });
  fireEvent.change(search, { target: { value: "SOBABCD1234ABCD1234ABCD1234" } });
  await waitFor(() => expect(searched).toContain("1234"));
  expect(search).toHaveValue("1234");
  expect(searched).not.toContainEqual(expect.stringContaining("SOB"));
});

test("the admin can issue a card with a separate reviewed sale price", async () => {
  renderApp(<GiftCardsView mode="admin" role="owner" />);
  await screen.findByText("Birthday");
  fireEvent.click(screen.getByRole("button", { name: "New gift card" }));
  const value = screen.getByLabelText("Gift value (EUR)");
  const price = screen.getByLabelText("Sale price (EUR, optional)");
  const submit = screen.getByRole("button", { name: "Create gift purchase" });
  fireEvent.change(value, { target: { value: "30" } });
  fireEvent.change(price, { target: { value: "0" } });
  fireEvent.click(submit);
  expect(
    screen.getByText("Enter a positive amount in euros with up to two decimal places."),
  ).toBeInTheDocument();
  expect(price).toHaveFocus();
  expect(posts).toHaveLength(0);
  fireEvent.change(price, { target: { value: "24,50" } });
  fireEvent.click(submit);
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0]?.body).toMatchObject({ amountCents: 3000, purchasePriceCents: 2450 });
});
