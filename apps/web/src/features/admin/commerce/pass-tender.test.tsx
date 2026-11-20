import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { PassPurchaseRefund, PassTender } from "./pass-tender";

const realFetch = globalThis.fetch;
const id = "0198f5a0-7b1c-7000-8000-000000000100";
let sent: Record<string, unknown>[];
let loseRefundResponse: boolean;
let rateLimitRefund: boolean;
beforeEach(() => {
  sent = [];
  loseRefundResponse = false;
  rateLimitRefund = false;
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (init?.method === "POST") sent.push({ path, ...body });
    if (path.endsWith("/eligible"))
      return Response.json({
        eligible: [
          {
            passId: id,
            name: "Three visits",
            kind: "package",
            period: {
              id,
              contractId: id,
              index: 0,
              checkoutId: id,
              status: "active",
              priceCents: 1000,
              startsAt: "2026-11-01T00:00:00.000Z",
              endsAt: null,
              availableUses: 2,
              usedUses: 1,
              heldUses: 0,
              returnedUses: 0,
              remainingAllocationCents: 666,
              version: 1,
            },
            lines: [{ id, description: "Haircut", amountCents: 2000 }],
          },
        ],
      });
    if (path.endsWith("/refund-quote"))
      return Response.json({
        amountCents: Number(body.unitCount) * 333,
        unitCount: Number(body.unitCount),
        excessCents: 0,
        availableUses: 2,
      });
    if (path.endsWith("/refunds")) {
      if (loseRefundResponse) {
        loseRefundResponse = false;
        throw new Error("Lost refund response");
      }
      if (rateLimitRefund) {
        rateLimitRefund = false;
        return Response.json(
          { error: { code: "rate_limited", message: "Try again" } },
          { status: 429 },
        );
      }
      return Response.json({
        id,
        paymentId: id,
        amountCents: body.amountCents,
        status: "succeeded",
        reason: body.reason,
        createdAt: "2026-11-01T00:00:00.000Z",
        updatedAt: "2026-11-01T00:00:00.000Z",
      });
    }
    return Response.json({
      payment: {
        id,
        order: null,
        method: body.method,
        status: "succeeded",
        amountCents: body.amountCents,
      },
      form: null,
    });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});
test("a prepaid tender submits the selected service and immutable server amount", async () => {
  renderApp(<PassTender checkoutId={id} mode="client" />);
  await screen.findByRole("button", { name: "Use prepaid visit" });
  fireEvent.click(screen.getByRole("button", { name: "Use prepaid visit" }));
  await waitFor(() =>
    expect(sent.some((r) => r.path === `/api/me/checkouts/${id}/payments`)).toBe(true),
  );
  const request = sent.find((r) => r.method === "package");
  expect(request).toMatchObject({ amountCents: 2000, passPeriodId: id, checkoutLineId: id });
});
test("purchase returns use the server quote for whole visits rather than browser arithmetic", async () => {
  renderApp(
    <PassPurchaseRefund periodId={id} paymentId={id} maximumCents={1000} generation="live" />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Refund payment" }));
  await screen.findByLabelText("Unused visits to return");
  fireEvent.change(screen.getByLabelText("Unused visits to return"), { target: { value: "2" } });
  await waitFor(() => expect(screen.getByLabelText("Refund amount")).toHaveValue("6.66"));
  expect(screen.getByLabelText("Refund amount")).toHaveAttribute("readonly");
  fireEvent.change(screen.getByLabelText("Refund reason"), {
    target: { value: "Two unused visits" },
  });
  loseRefundResponse = true;
  rateLimitRefund = true;
  const confirm = screen.getByRole("button", { name: "Confirm refund request" });
  fireEvent.click(confirm);
  await screen.findByRole("alert");
  expect(screen.getByLabelText("Refund reason")).toBeDisabled();
  fireEvent.click(confirm);
  const requests = () =>
    sent.filter((r) => r.path === `/api/admin/commerce/payments/${id}/refunds`);
  await waitFor(() => expect(requests()).toHaveLength(2));
  await waitFor(() => expect(confirm).toBeEnabled());
  expect(screen.getByLabelText("Refund reason")).toBeDisabled();
  fireEvent.click(confirm);
  await waitFor(() => expect(requests()).toHaveLength(3));
  expect(requests()[0]).toMatchObject({
    amountCents: 666,
    passQuote: { periodId: id, generation: "live", unitCount: 2 },
  });
  expect(requests()[1]).toEqual(requests()[0]);
  expect(requests()[2]).toEqual(requests()[0]);
});
