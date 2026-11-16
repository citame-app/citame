import { afterEach, expect, mock, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { LoyaltyPolicyForm } from "./loyalty-policy-form";

const originalFetch = globalThis.fetch;
const policy = {
  enabled: false,
  earnEveryCents: 100,
  pointsPerStep: 1,
  redeemValueCents: 1,
  maximumDiscountBasisPoints: 2000,
  expiryDays: 365,
  version: 3,
};
afterEach(() => {
  globalThis.fetch = originalFetch;
});
test("program settings convert money and percentages and preserve the reviewed revision", async () => {
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = mock(async (_input, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (body) bodies.push(body);
    return Response.json(body ? { ...body, version: 4 } : policy);
  }) as unknown as typeof fetch;
  renderApp(<LoyaltyPolicyForm />);
  fireEvent.change(await screen.findByLabelText("Discount value per point (EUR)"), {
    target: { value: "0.10" },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "Enable earning and redeeming points" }));
  fireEvent.click(screen.getByRole("button", { name: "Save points program" }));
  await waitFor(() =>
    expect(bodies[0]).toMatchObject({
      enabled: true,
      redeemValueCents: 10,
      maximumDiscountBasisPoints: 2000,
      version: 3,
    }),
  );
});
test("a stale program response preserves the operator draft", async () => {
  globalThis.fetch = mock(async (_input, init) =>
    init?.method === "PUT"
      ? Response.json({ error: { code: "version_conflict", message: "Changed" } }, { status: 409 })
      : Response.json(policy),
  ) as unknown as typeof fetch;
  renderApp(<LoyaltyPolicyForm />);
  fireEvent.change(await screen.findByLabelText("Discount value per point (EUR)"), {
    target: { value: "0.15" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save points program" }));
  await screen.findByRole("alert");
  expect(screen.getByLabelText("Discount value per point (EUR)")).toHaveValue("0.15");
});
