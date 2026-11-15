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
