import { afterEach, expect, mock, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { PromotionsView } from "./promotions-view";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
test("promotion creation validates codes and sends exact percentage and spending limits", async () => {
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = mock(async (input, init) => {
    if (String(input).endsWith("/services")) return Response.json({ services: [] });
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      return Response.json({
        ...body,
        id: "0198f5a0-7b1c-7000-8000-000000000100",
        version: 1,
        createdAt: "2026-11-01T12:00:00.000Z",
      });
    }
    return Response.json({ promotions: [], pagination: { page: 1, pageSize: 20, total: 0 } });
  }) as unknown as typeof fetch;
  renderApp(<PromotionsView />);
  fireEvent.click(await screen.findByRole("button", { name: "New promotion" }));
  fireEvent.change(screen.getByLabelText("Offer name"), { target: { value: "Welcome offer" } });
  fireEvent.change(screen.getByLabelText("Code (letters, numbers, hyphen or underscore)"), {
    target: { value: "welcome_10" },
  });
  fireEvent.change(screen.getByLabelText("Discount (% or EUR)"), { target: { value: "12.5" } });
  fireEvent.change(screen.getByLabelText("Minimum eligible spend (EUR)"), {
    target: { value: "50" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save promotion" }));
  await waitFor(() =>
    expect(bodies[0]).toMatchObject({
      code: "WELCOME_10",
      name: "Welcome offer",
      kind: "percent",
      value: 1250,
      minimumSpendCents: 5000,
      perClientLimit: 1,
      version: null,
    }),
  );
});
test("timed promotions require reviewed weekdays and submit service-only local time conditions", async () => {
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = mock(async (input, init) => {
    if (String(input).endsWith("/services")) return Response.json({ services: [] });
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      return Response.json({
        ...body,
        id: "0198f5a0-7b1c-7000-8000-000000000100",
        version: 1,
        createdAt: "2026-11-01T12:00:00.000Z",
      });
    }
    return Response.json({ promotions: [], pagination: { page: 1, pageSize: 20, total: 0 } });
  }) as unknown as typeof fetch;
  renderApp(<PromotionsView />);
  fireEvent.click(await screen.findByRole("button", { name: "New promotion" }));
  fireEvent.change(screen.getByLabelText("Offer name"), { target: { value: "Quiet mornings" } });
  fireEvent.change(screen.getByLabelText("Code (letters, numbers, hyphen or underscore)"), {
    target: { value: "QUIET" },
  });
  fireEvent.click(screen.getByLabelText("Limit to appointment start times"));
  fireEvent.change(screen.getByLabelText("Appointment starts from"), {
    target: { value: "10:00" },
  });
  fireEvent.change(screen.getByLabelText("Appointment starts before"), {
    target: { value: "13:00" },
  });
  fireEvent.change(screen.getByLabelText("Booked at most this many hours before the visit"), {
    target: { value: "24" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save promotion" }));
  expect(bodies).toHaveLength(0);
  fireEvent.click(screen.getByLabelText("Monday"));
  fireEvent.click(screen.getByRole("button", { name: "Save promotion" }));
  await waitFor(() =>
    expect(bodies[0]).toMatchObject({
      eligibleKinds: ["service"],
      timing: { weekdays: [1], startMinute: 600, endMinute: 780, lastMinuteHours: 24 },
    }),
  );
});
test("an uncertain promotion write freezes its original packet and leaves an explicit same-change retry", async () => {
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = mock(async (input, init) => {
    if (String(input).endsWith("/services")) return Response.json({ services: [] });
    if (init?.method === "POST") {
      bodies.push(JSON.parse(String(init.body)));
      throw new TypeError("Fixture response lost after commit");
    }
    return Response.json({ promotions: [], pagination: { page: 1, pageSize: 20, total: 0 } });
  }) as unknown as typeof fetch;
  renderApp(<PromotionsView />);
  fireEvent.click(await screen.findByRole("button", { name: "New promotion" }));
  fireEvent.change(screen.getByLabelText("Offer name"), {
    target: { value: "Same reviewed terms" },
  });
  fireEvent.change(screen.getByLabelText("Code (letters, numbers, hyphen or underscore)"), {
    target: { value: "FROZEN" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save promotion" }));
  await screen.findByText(
    "The response is uncertain. Retry the same change or reload the saved policy before editing again.",
  );
  expect(screen.getByLabelText("Offer name")).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Retry the same change" }));
  await waitFor(() => expect(bodies).toHaveLength(2));
  expect(bodies[1]).toEqual(bodies[0]);
});
