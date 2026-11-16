import { afterEach, expect, mock, test } from "bun:test";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../test/render";
import { BookingLinks } from "./booking-links";

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});
test("changing a selection never displays a QR from an older asynchronous render", async () => {
  const id = "0198f5a0-7b1c-7000-8000-000000000001";
  globalThis.fetch = mock(async (url: unknown) =>
    Response.json(
      String(url).includes("/staff")
        ? { staff: [{ id, displayName: "Stylist A", serviceIds: [id] }] }
        : {
            services: [
              {
                id,
                name: "Haircut",
                description: null,
                durationMinutes: 30,
                bufferMinutes: 0,
                priceCents: 2000,
                currency: "EUR",
              },
            ],
          },
    ),
  ) as unknown as typeof fetch;
  const jobs: { url: string; resolve: (value: string) => void }[] = [];
  renderApp(
    <BookingLinks
      salonName="Sisters of Beauty"
      origin="https://booking.example"
      makeQr={(url) =>
        new Promise((resolve) => {
          jobs.push({ url, resolve });
        })
      }
    />,
  );
  await waitFor(() => expect(jobs).toHaveLength(1));
  fireEvent.click(await screen.findByRole("checkbox", { name: /Haircut/ }));
  await waitFor(() => expect(jobs).toHaveLength(2));
  await act(async () => {
    jobs[1]?.resolve("data:image/png;base64,bmV3");
  });
  expect(screen.getByAltText("Booking QR code")).toHaveAttribute(
    "src",
    "data:image/png;base64,bmV3",
  );
  await act(async () => {
    jobs[0]?.resolve("data:image/png;base64,b2xk");
  });
  expect(screen.getByAltText("Booking QR code")).toHaveAttribute(
    "src",
    "data:image/png;base64,bmV3",
  );
  expect((screen.getByLabelText("Booking link") as HTMLInputElement).value).toContain(id);
});

test("a professional removed meanwhile cannot be shared and the choices can be explicitly cleared", async () => {
  const serviceId = "0198f5a0-7b1c-7000-8000-000000000001";
  const staffId = "0198f5a0-7b1c-7000-8000-000000000002";
  let active = true;
  globalThis.fetch = mock(async (url: unknown) =>
    Response.json(
      String(url).includes("/staff")
        ? {
            staff: [
              { id: serviceId, displayName: "Stylist B", serviceIds: [serviceId] },
              ...(active
                ? [{ id: staffId, displayName: "Stylist A", serviceIds: [serviceId] }]
                : []),
            ],
          }
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
    ),
  ) as unknown as typeof fetch;
  const view = renderApp(
    <BookingLinks
      salonName="Sisters of Beauty"
      origin="https://booking.example"
      makeQr={async () => "data:image/png;base64,cXI="}
    />,
  );
  fireEvent.click(await screen.findByRole("checkbox", { name: "Haircut" }));
  fireEvent.change(screen.getByLabelText("Professional (optional)"), {
    target: { value: staffId },
  });
  active = false;
  await act(async () => {
    await view.queryClient.invalidateQueries({ queryKey: ["staff"] });
  });
  await screen.findByText(
    "Some selected treatments or the professional are no longer available. Review the current choices before sharing.",
  );
  expect(screen.getByRole("button", { name: "Copy booking link" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Clear selections" }));
  expect(screen.getByRole("button", { name: "Copy booking link" })).toBeEnabled();
  expect(screen.getByLabelText("Booking link")).toHaveValue("https://booking.example/book");
});
