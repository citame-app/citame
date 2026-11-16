import { afterEach, expect, mock, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { RewardTender } from "./reward-tender";

const originalFetch = globalThis.fetch;
const id = "0198f5a0-7b1c-7000-8000-000000000100";
const policy = {
  enabled: true,
  earnEveryCents: 100,
  pointsPerStep: 1,
  redeemValueCents: 10,
  maximumDiscountBasisPoints: 2000,
  expiryDays: 365,
  version: 2,
};
afterEach(() => {
  globalThis.fetch = originalFetch;
});
function requests(timed = false) {
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = mock(async (input, init) => {
    const path = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (path.endsWith("/quote")) {
      if (timed)
        return Response.json({
          name: "Quiet mornings",
          kind: "promotion",
          pointsUsed: 0,
          maximumPoints: 0,
          discountCents: 1000,
          currentTotalCents: 10000,
          newTotalCents: 9000,
          promotionVersion: 3,
          appointmentTiming: {
            timing: { weekdays: [1], startMinute: 600, endMinute: 780, lastMinuteHours: 24 },
            timeZone: "Europe/Madrid",
          },
        });
      return Response.json({
        name: "Loyalty points",
        kind: "points",
        pointsUsed: body.points,
        maximumPoints: 100,
        discountCents: body.points * 10,
        currentTotalCents: 10000,
        newTotalCents: 10000 - body.points * 10,
      });
    }
    if (path.endsWith("/reward") && init?.method === "POST") {
      bodies.push(body);
      return Response.json({
        id,
        appointmentId: null,
        clientId: id,
        currency: "EUR",
        status: "open",
        subtotalCents: 10000,
        discountCents: 1000,
        tipCents: 0,
        taxCents: 0,
        totalCents: 9000,
        paidCents: 0,
        refundedCents: 0,
        balanceCents: 9000,
        lines: [],
        payments: [],
        createdAt: "2026-11-01T12:00:00.000Z",
      });
    }
    return Response.json({
      policy,
      availablePoints: 100,
      balancePoints: 100,
      reservedPoints: 0,
      debtPoints: 0,
      expiringPoints: 0,
      movements: [],
      pagination: { page: 1, pageSize: 20, total: 0 },
    });
  }) as unknown as typeof fetch;
  return bodies;
}
test("the customer previews a server-priced point discount and explicitly applies the reviewed amounts", async () => {
  const bodies = requests();
  renderApp(<RewardTender checkout={{ id, clientId: id, totalCents: 10000 }} mode="client" />);
  await screen.findByText("100 points available");
  fireEvent.change(screen.getByLabelText("Reward type"), { target: { value: "points" } });
  fireEvent.change(screen.getByLabelText("Points to use"), { target: { value: "100" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview discount" }));
  expect(await screen.findByText("Save €10 · New total €90")).toBeInTheDocument();
  expect(bodies).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Apply this discount" }));
  await waitFor(() =>
    expect(bodies[0]).toMatchObject({
      kind: "points",
      points: 100,
      expectedTotalCents: 10000,
      expectedDiscountCents: 1000,
    }),
  );
});
test("changing points discards the previous quote before another application", async () => {
  requests();
  renderApp(<RewardTender checkout={{ id, clientId: id, totalCents: 10000 }} mode="client" />);
  await screen.findByText("100 points available");
  fireEvent.change(screen.getByLabelText("Reward type"), { target: { value: "points" } });
  fireEvent.change(screen.getByLabelText("Points to use"), { target: { value: "100" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview discount" }));
  await screen.findByRole("button", { name: "Apply this discount" });
  fireEvent.change(screen.getByLabelText("Points to use"), { target: { value: "50" } });
  expect(screen.queryByRole("button", { name: "Apply this discount" })).toBeNull();
});

test("a timed offer displays its conditions before applying the reviewed revision", async () => {
  const bodies = requests(true);
  renderApp(<RewardTender checkout={{ id, clientId: id, totalCents: 10000 }} mode="client" />);
  await screen.findByText("100 points available");
  fireEvent.change(screen.getByLabelText("Promotion code"), { target: { value: "QUIET" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview discount" }));
  expect(await screen.findByText(/Monday.*10:00.*13:00.*Europe\/Madrid/)).toBeInTheDocument();
  expect(screen.getByText(/Originally booked no more than 24 hours/)).toBeInTheDocument();
  expect(bodies).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Apply this discount" }));
  await waitFor(() =>
    expect(bodies[0]).toMatchObject({
      kind: "promotion",
      code: "QUIET",
      expectedPromotionVersion: 3,
    }),
  );
});
