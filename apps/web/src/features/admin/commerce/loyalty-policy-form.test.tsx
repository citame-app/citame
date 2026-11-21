import { afterEach, expect, mock, test } from "bun:test";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
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
  generation: "loyalty-initial",
};
afterEach(() => {
  globalThis.fetch = originalFetch;
});
test("program settings convert money and percentages and preserve the reviewed revision", async () => {
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = mock(async (_input, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (body) bodies.push(body);
    return Response.json(body ? { ...body, version: 4, generation: policy.generation } : policy);
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

test("live policy changes replace clean fields and keep a stale draft until reload", async () => {
  let current = policy;
  globalThis.fetch = mock(async () => Response.json(current)) as unknown as typeof fetch;
  const view = renderApp(<LoyaltyPolicyForm />);
  const label = "Discount value per point (EUR)";
  const input = await screen.findByLabelText(label);
  current = { ...current, redeemValueCents: 7, version: 4 };
  await act(() => view.queryClient.invalidateQueries({ queryKey: ["rewards", "policy"] }));
  await waitFor(() => expect(input).toHaveValue("0.07"));

  fireEvent.change(input, { target: { value: "0.11" } });
  current = { ...current, redeemValueCents: 13, generation: "restored" };
  await act(() => view.queryClient.invalidateQueries({ queryKey: ["rewards", "policy"] }));
  expect(input).toHaveValue("0.11");
  expect(await screen.findByRole("status")).toHaveTextContent("The program changed");
  expect(screen.getByRole("button", { name: "Save points program" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Reload current program" }));
  await waitFor(() => expect(input).toHaveValue("0.13"));
});

test("an unconfirmed save can replay the same terms after the live response arrives", async () => {
  let current = policy;
  const submissions: unknown[] = [];
  globalThis.fetch = mock(async (_input, init) => {
    if (init?.method !== "PUT") return Response.json(current);
    const body = JSON.parse(String(init.body));
    const generation = new Headers(init.headers).get("x-citame-generation");
    submissions.push({ body, generation });
    current = { ...body, version: body.version + 1, generation };
    if (submissions.length === 1) throw new TypeError("Disconnected after commit");
    return Response.json(current);
  }) as unknown as typeof fetch;
  const view = renderApp(<LoyaltyPolicyForm />);
  const input = await screen.findByLabelText("Discount value per point (EUR)");
  fireEvent.change(input, { target: { value: "0.09" } });
  fireEvent.click(screen.getByRole("button", { name: "Save points program" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Cloud has not confirmed");
  await act(() => view.queryClient.invalidateQueries({ queryKey: ["rewards", "policy"] }));
  const retry = await screen.findByRole("button", { name: "Retry the same change" });
  expect(input).toBeDisabled();
  fireEvent.click(retry);
  await waitFor(() => expect(submissions).toHaveLength(2));
  expect(submissions[1]).toEqual(submissions[0]);
  expect(await screen.findByRole("status")).toHaveTextContent("Points program saved");
});
