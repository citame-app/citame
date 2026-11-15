import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { CommissionPanel } from "./accounting-view";

const realFetch = globalThis.fetch;
const id = "0198f5a0-7b1c-7000-8000-000000000100";
let posts: Record<string, unknown>[];
beforeEach(() => {
  posts = [];
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
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
