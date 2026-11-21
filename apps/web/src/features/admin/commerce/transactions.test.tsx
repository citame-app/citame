import { afterEach, expect, mock, test } from "bun:test";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { Transactions } from "./transactions";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("transaction totals follow grouping and recompute date filters when the salon timezone changes", async () => {
  let timezone = "UTC";
  const queries: URLSearchParams[] = [];
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/salon") {
      return Response.json({
        name: "Test salon",
        timezone,
        slotGranularityMinutes: 15,
        minNoticeMinutes: 0,
        maxDaysAhead: 90,
        onlineBookingEnabled: true,
      });
    }
    queries.push(url.searchParams);
    return Response.json({
      page: 1,
      pageSize: 25,
      total: 26,
      checkouts: [
        {
          id: "0198f5a0-7b1c-7000-8000-000000000100",
          appointmentId: null,
          clientId: null,
          currency: "EUR",
          status: "paid",
          subtotalCents: 2000,
          discountCents: 0,
          tipCents: 0,
          taxCents: 0,
          totalCents: 2000,
          paidCents: 2000,
          refundedCents: 0,
          balanceCents: 0,
          lines: [],
          payments: [],
          createdAt: "2026-03-09T23:30:00.000Z",
        },
      ],
      groupTotals: {
        timezone,
        rows: [
          {
            period: url.searchParams.get("groupBy") === "month" ? "2026-03-01" : "2026-03-09",
            receipts: 26,
            paidCents: 52000,
            refundedCents: 1000,
          },
        ],
      },
    });
  }) as unknown as typeof fetch;
  const { queryClient } = renderApp(<Transactions onOpen={() => {}} />, { timeZone: "UTC" });
  await screen.findByText("€510");
  fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-03-09" } });
  await waitFor(() => expect(queries.at(-1)?.get("from")).toBe("2026-03-09T00:00:00.000Z"));
  fireEvent.click(screen.getByRole("button", { name: /^Months$/ }));
  await screen.findByRole("heading", { name: "March 2026" });
  expect(screen.getByText("€510")).toBeInTheDocument();
  expect(queries.at(-1)?.get("groupBy")).toBe("month");
  timezone = "Europe/Madrid";
  await act(() => queryClient.invalidateQueries({ queryKey: ["salon"] }));
  await waitFor(() => expect(queries.at(-1)?.get("from")).toBe("2026-03-08T23:00:00.000Z"));
});
