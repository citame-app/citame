import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { PassesView } from "./passes-view";

const realFetch = globalThis.fetch;
const id = "0198f5a0-7b1c-7000-8000-000000000100";
let version: number;
let amount: number;
let recurring: boolean;
let posts: Record<string, unknown>[];
const period = {
  id,
  contractId: id,
  index: 0,
  checkoutId: id,
  status: "pending",
  priceCents: 1000,
  startsAt: null,
  endsAt: null,
  availableUses: 0,
  usedUses: 0,
  heldUses: 0,
  returnedUses: 0,
  remainingAllocationCents: 0,
  version: 1,
};
const pass = {
  id,
  planId: id,
  clientId: id,
  kind: "membership",
  name: "Monthly visits",
  priceCents: 1000,
  currency: "EUR",
  includedUses: 2,
  discountBasisPoints: 0,
  serviceIds: [id],
  periodMonths: 1,
  validityDays: null,
  timezone: "Europe/Madrid",
  status: "pending",
  renewalMode: "automatic",
  autoPayReady: false,
  cancelAtPeriodEnd: false,
  version: 1,
  periods: [period],
  createdAt: "2026-11-01T12:00:00.000Z",
};
beforeEach(() => {
  version = 1;
  amount = 1000;
  recurring = true;
  posts = [];
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path.endsWith("/capabilities"))
      return Response.json({
        provider: "redsys",
        environment: "test",
        card: true,
        bizum: false,
        giftCards: true,
        recurring,
        currency: "EUR",
      });
    if (path.endsWith("/benefit-plans"))
      return Response.json({
        plans: [
          {
            id,
            name: "Monthly visits",
            description: null,
            kind: "membership",
            priceCents: amount,
            currency: "EUR",
            taxBasisPoints: 0,
            includedUses: 2,
            discountBasisPoints: 0,
            serviceIds: [id],
            periodMonths: 1,
            validityDays: null,
            active: true,
            version,
            createdAt: "2026-11-01T12:00:00.000Z",
            updatedAt: "2026-11-01T12:00:00.000Z",
          },
        ],
      });
    if (path.endsWith("/services"))
      return Response.json({
        services: [
          {
            id,
            name: "Haircut",
            description: null,
            durationMinutes: 45,
            bufferMinutes: 0,
            priceCents: 2000,
            currency: "EUR",
          },
        ],
      });
    if (path.endsWith(`/passes/${id}`)) return Response.json(pass);
    if (path.endsWith("/periods"))
      return Response.json({ periods: [period], pagination: { page: 1, pageSize: 20, total: 1 } });
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      posts.push(body);
      return Response.json({
        pass,
        period,
        checkout: {
          id,
          appointmentId: null,
          clientId: id,
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
        },
      });
    }
    return Response.json({ passes: [], pagination: { page: 1, pageSize: 20, total: 0 } });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});
async function open() {
  const view = renderApp(<PassesView mode="client" role="client" clientId={id} />);
  await screen.findByRole("button", { name: "Purchase plan" });
  await screen.findByText("Haircut");
  fireEvent.click(screen.getByRole("button", { name: "Purchase plan" }));
  return view;
}
test("recurring payment is off by default and requires explicit price-bound client consent", async () => {
  await open();
  expect(screen.getByLabelText("Renewal payment")).toHaveValue("manual");
  fireEvent.change(screen.getByLabelText("Renewal payment"), { target: { value: "automatic" } });
  expect(screen.getByRole("button", { name: "Create purchase" })).toBeDisabled();
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "I authorize automatic card payments of €10 each month until I stop renewal.",
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Create purchase" }));
  await waitFor(() =>
    expect(posts[0]).toMatchObject({
      renewalMode: "automatic",
      acceptRecurring: true,
      planVersion: 1,
      consentVersion: "sob.membership-recurring.v1",
    }),
  );
});
test("a changed plan price clears consent and requires review before purchase", async () => {
  const view = await open();
  fireEvent.change(screen.getByLabelText("Renewal payment"), { target: { value: "automatic" } });
  fireEvent.click(screen.getByRole("checkbox", { name: /I authorize automatic card payments/ }));
  version = 2;
  amount = 2000;
  await act(async () => {
    await view.queryClient.invalidateQueries({ queryKey: ["passes", "catalog"] });
  });
  await screen.findByText("Plan terms changed. Review the current price and authorize it again.");
  expect(
    screen.getByRole("checkbox", { name: /I authorize automatic card payments/ }),
  ).not.toBeChecked();
  expect(screen.getByRole("button", { name: "Create purchase" })).toBeDisabled();
});
test("unconfigured recurring facilities never offer automatic payment enrollment", async () => {
  recurring = false;
  await open();
  expect(screen.queryByLabelText("Renewal payment")).toBeNull();
  expect(screen.getByText("Haircut")).toBeInTheDocument();
});
