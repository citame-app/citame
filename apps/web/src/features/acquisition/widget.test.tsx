import { afterEach, expect, mock, test } from "bun:test";
import { screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../test/render";
import { BookingWidget } from "./widget";

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});
test("the paused widget keeps the salon link and skips the booking catalog", () => {
  const fetch = mock(() => Promise.resolve(Response.json({})));
  globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
  renderApp(
    <BookingWidget
      salonName="Sisters of Beauty"
      onlineBookingEnabled={false}
      initialSelection={{ serviceIds: [] }}
    />,
  );
  expect(screen.getByRole("heading", { name: "Online booking is paused" })).toBeVisible();
  expect(screen.getByRole("link", { name: "Sisters of Beauty" })).toBeVisible();
  expect(screen.queryByRole("link", { name: /Continue to booking/ })).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

test("the widget only reads the public catalog and carries the chosen services to first-party booking in a new tab", async () => {
  const serviceId = "0198f5a0-7b1c-7000-8000-000000000001";
  const staffId = "0198f5a0-7b1c-7000-8000-000000000002";
  const methods: string[] = [];
  globalThis.fetch = mock(async (url: unknown, init?: RequestInit) => {
    methods.push(init?.method ?? "GET");
    return Response.json(
      String(url).includes("/staff")
        ? { staff: [{ id: staffId, displayName: "Stylist A", serviceIds: [serviceId] }] }
        : {
            services: [
              {
                id: serviceId,
                name: "Haircut",
                description: null,
                durationMinutes: 30,
                bufferMinutes: 0,
                priceCents: 2000,
                currency: "EUR",
              },
            ],
          },
    );
  }) as unknown as typeof fetch;
  renderApp(
    <BookingWidget
      salonName="Sisters of Beauty"
      initialSelection={{ serviceIds: [serviceId], staffId }}
    />,
  );
  const link = await screen.findByRole("link", { name: "Continue to booking · opens new tab" });
  await waitFor(() => expect(screen.getByRole("checkbox", { name: "Haircut" })).toBeChecked());
  expect(link).toHaveAttribute("target", "_blank");
  expect(link.getAttribute("rel")).toContain("noopener");
  expect(link.getAttribute("href")).toContain(serviceId);
  expect(link.getAttribute("href")).toContain(staffId);
  expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  expect(methods.length).toBeGreaterThanOrEqual(2);
  expect(methods.every((method) => method === "GET")).toBe(true);
});
