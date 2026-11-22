import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { GiftOfferOrderForm } from "./gift-offer-order";

const id = "0198f5a0-7b1c-7000-8000-000000000100";
const realFetch = globalThis.fetch;
const offer = {
  id,
  name: "Facial gift",
  description: "",
  theme: "sage",
  amountCents: 3000,
  priceCents: 2500,
  validityDays: 30,
  version: 4,
  eligibleServices: [],
};
const key = `citame:gift-order:client-one:${id}`;
let posted: object[];
let publicOffers: object[];
let sessionExpired: boolean;
beforeEach(() => {
  sessionStorage.removeItem(key);
  posted = [];
  sessionExpired = false;
  publicOffers = [offer];
  globalThis.fetch = mock(async (_url: URL | RequestInfo, init?: RequestInit) => {
    if (init?.method === "POST") {
      posted.push(JSON.parse(String(init.body)));
      if (sessionExpired)
        return Response.json(
          { error: { code: "unauthorized", message: "Sign in" } },
          { status: 401 },
        );
      throw new TypeError("Response dropped");
    }
    return Response.json({ offers: publicOffers });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  sessionStorage.removeItem(key);
});
test("an uncertain public order reuses the server-priced request after reopening", async () => {
  const callback = mock();
  const { unmount } = renderApp(
    <GiftOfferOrderForm offerId={id} actorId="client-one" onOrder={callback} />,
  );
  await screen.findByText("Value €30 · Price €25");
  fireEvent.click(screen.getByRole("button", { name: "Continue to payment" }));
  await screen.findByRole("alert");
  expect(posted).toHaveLength(1);
  expect(posted[0]).toEqual({ offerId: id, version: 4, idempotencyKey: expect.any(String) });
  expect(callback).not.toHaveBeenCalled();
  unmount();
  publicOffers = [];
  sessionExpired = true;
  renderApp(<GiftOfferOrderForm offerId={id} actorId="client-one" onOrder={callback} />);
  fireEvent.click(await screen.findByRole("button", { name: "Retry the same purchase" }));
  await waitFor(() => expect(posted).toHaveLength(2));
  expect(posted[1]).toEqual(posted[0]);
  await screen.findByRole("alert");
  expect(JSON.parse(sessionStorage.getItem(key) ?? "null")).toEqual(posted[0]);
});
