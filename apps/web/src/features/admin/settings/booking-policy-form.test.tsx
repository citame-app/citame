import { afterEach, expect, mock, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { BookingPolicyForm } from "./booking-policy-form";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
test("owner policy changes preserve revision and convert displayed percentages to integer basis points", async () => {
  const bodies: unknown[] = [];
  const policy = {
    enabled: false,
    depositKind: "percent",
    depositValue: 2500,
    holdMinutes: 15,
    cancellationWindowMinutes: 1440,
    lateCancellationBasisPoints: 0,
    noShowBasisPoints: 0,
    trustedExempt: true,
    version: 7,
  };
  globalThis.fetch = mock(async (_input, init) => {
    if (init?.method === "PUT") bodies.push(JSON.parse(String(init.body)));
    return Response.json({ ...policy, ...(init?.body ? JSON.parse(String(init.body)) : {}) });
  }) as unknown as typeof fetch;
  renderApp(<BookingPolicyForm />);
  fireEvent.change(await screen.findByLabelText("Deposit (% or EUR)"), {
    target: { value: "30.5" },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "Require a booking deposit" }));
  fireEvent.click(screen.getByRole("button", { name: "Save booking policy" }));
  await waitFor(() =>
    expect(bodies).toContainEqual({ ...policy, enabled: true, depositValue: 3050 }),
  );
});
test("stale policy errors preserve the draft until explicit reload", async () => {
  const policy = {
    enabled: false,
    depositKind: "percent",
    depositValue: 2500,
    holdMinutes: 15,
    cancellationWindowMinutes: 1440,
    lateCancellationBasisPoints: 0,
    noShowBasisPoints: 0,
    trustedExempt: true,
    version: 1,
  };
  globalThis.fetch = mock(async (_input, init) =>
    init?.method === "PUT"
      ? Response.json({ error: { code: "version_conflict", message: "Changed" } }, { status: 409 })
      : Response.json(policy),
  ) as unknown as typeof fetch;
  renderApp(<BookingPolicyForm />);
  fireEvent.change(await screen.findByLabelText("Deposit (% or EUR)"), { target: { value: "35" } });
  fireEvent.click(screen.getByRole("button", { name: "Save booking policy" }));
  await screen.findByRole("alert");
  expect(screen.getByLabelText("Deposit (% or EUR)")).toHaveValue("35");
  fireEvent.click(screen.getByRole("button", { name: "Reload current policy" }));
  await waitFor(() => expect(screen.getByLabelText("Deposit (% or EUR)")).toHaveValue("25.00"));
});
