import { afterEach, expect, mock, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { CommerceView } from "./commerce-view";

const originalFetch = globalThis.fetch;
const id = "0198f5a0-7b1c-7000-8000-000000000100";
afterEach(() => {
  globalThis.fetch = originalFetch;
});
test("a salon sale explicitly links the selected customer so points belong to the correct account", async () => {
  const bodies: Record<string, unknown>[] = [];
  const receipt = {
    id,
    clientId: id,
    appointmentId: null,
    currency: "EUR",
    status: "open",
    subtotalCents: 1000,
    discountCents: 0,
    tipCents: 0,
    taxCents: 0,
    totalCents: 1000,
    paidCents: 0,
    refundedCents: 0,
    balanceCents: 1000,
    lines: [],
    payments: [],
    createdAt: "2026-11-01T12:00:00.000Z",
  };
  globalThis.fetch = mock(async (input, init) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path.endsWith("/checkouts") && init?.method === "POST") {
      bodies.push(JSON.parse(String(init.body)));
      return Response.json(receipt);
    }
    if (path.endsWith("/checkouts")) return Response.json({ checkouts: [] });
    if (path.endsWith("/staff")) return Response.json({ staff: [] });
    if (path.endsWith("/current")) return Response.json({ session: null });
    if (path.endsWith("/clients"))
      return Response.json({
        clients: [
          {
            id,
            name: "Known buyer",
            phone: null,
            email: null,
            notes: null,
            createdAt: "2026-11-01T12:00:00.000Z",
            updatedAt: "2026-11-01T12:00:00.000Z",
            appointmentCount: 0,
            lastVisitAt: null,
          },
        ],
        page: 1,
        pageSize: 8,
        total: 1,
      });
    if (path.endsWith("/products"))
      return Response.json({ products: [], pagination: { page: 1, pageSize: 20, total: 0 } });
    if (path.endsWith("/capabilities"))
      return Response.json({
        provider: "none",
        environment: null,
        currency: "EUR",
        card: false,
        bizum: false,
        giftCards: false,
      });
    if (path.endsWith(id)) return Response.json(receipt);
    return Response.json({}, { status: 404 });
  }) as unknown as typeof fetch;
  renderApp(<CommerceView role="owner" />);
  fireEvent.click(await screen.findByRole("button", { name: "New sale" }));
  fireEvent.change(await screen.findByLabelText("Search customer for points"), {
    target: { value: "Known" },
  });
  await screen.findByRole("option", { name: "Known buyer" });
  fireEvent.change(screen.getByLabelText("Customer points account"), { target: { value: id } });
  fireEvent.change(screen.getByLabelText("Item or service"), { target: { value: "Salon visit" } });
  fireEvent.change(screen.getByLabelText("Price (EUR)"), { target: { value: "10" } });
  fireEvent.click(screen.getByRole("button", { name: "Create checkout" }));
  await waitFor(() =>
    expect(bodies[0]).toMatchObject({
      clientId: id,
      lines: [
        {
          kind: "custom",
          description: "Salon visit",
          quantity: 1,
          unitAmountCents: 1000,
          taxBasisPoints: 0,
        },
      ],
    }),
  );
});
