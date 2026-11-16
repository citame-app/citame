import { afterEach, expect, mock, test } from "bun:test";
import { fireEvent, screen } from "@testing-library/react";
import { renderApp } from "../../../test/render";
import { SocialCreative } from "./social-creative";

const originalFetch = globalThis.fetch;
const originalClick = HTMLAnchorElement.prototype.click;
afterEach(() => {
  globalThis.fetch = originalFetch;
  HTMLAnchorElement.prototype.click = originalClick;
});
test("a changed price after preview blocks export and keeps the operator's choices", async () => {
  const id = "0198f5a0-7b1c-7000-8000-000000000001";
  let price = 2000;
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
                priceCents: price,
                currency: "EUR",
              },
            ],
          },
    ),
  ) as unknown as typeof fetch;
  const click = mock(() => {});
  HTMLAnchorElement.prototype.click = click;
  renderApp(
    <SocialCreative
      salonName="Sisters of Beauty"
      origin="https://booking.example"
      renderer={async () => ({
        dataUrl: "data:image/png;base64,cG9zdGVy",
        caption: "Haircut · €20",
        title: "Haircut",
        bookingUrl: "https://booking.example/book",
      })}
    />,
  );
  fireEvent.change(await screen.findByLabelText("Choose a treatment"), { target: { value: id } });
  fireEvent.click(screen.getByRole("button", { name: "Prepare preview" }));
  await screen.findByAltText("Creative preview: Haircut");
  expect(screen.getByRole("button", { name: "Download PNG" })).toBeDisabled();
  fireEvent.click(
    screen.getByLabelText(
      "I have reviewed the image, source permission and complete caption before exporting.",
    ),
  );
  price = 2500;
  fireEvent.click(screen.getByRole("button", { name: "Download PNG" }));
  await screen.findByText(
    "The source changed or its permission is no longer available. Reload sources and prepare a new preview.",
  );
  expect(click).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Choose a treatment")).toHaveValue(id);
});
