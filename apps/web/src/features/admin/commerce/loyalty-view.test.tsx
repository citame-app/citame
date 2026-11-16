import { afterEach, expect, mock, test } from "bun:test";
import { screen } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { LoyaltyView } from "./loyalty-view";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
test("customers see an honest disabled zero balance without operator program or adjustment controls", async () => {
  globalThis.fetch = mock(async () =>
    Response.json({
      policy: {
        enabled: false,
        earnEveryCents: 100,
        pointsPerStep: 1,
        redeemValueCents: 1,
        maximumDiscountBasisPoints: 2000,
        expiryDays: 365,
        version: 1,
      },
      balancePoints: 0,
      availablePoints: 0,
      reservedPoints: 0,
      debtPoints: 0,
      expiringPoints: 0,
      movements: [],
      pagination: { page: 1, pageSize: 20, total: 0 },
    }),
  ) as unknown as typeof fetch;
  renderApp(<LoyaltyView mode="client" role="client" />);
  expect(
    await screen.findByText(
      "The points program is currently unavailable. Recorded purchases keep their agreed rewards.",
    ),
  ).toBeInTheDocument();
  expect(screen.getByText("No point activity yet")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Save points program" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Record point adjustment" })).toBeNull();
});
