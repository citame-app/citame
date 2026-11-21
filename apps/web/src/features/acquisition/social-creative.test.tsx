import { afterEach, expect, mock, test } from "bun:test";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { renderApp } from "../../../test/render";
import type { CreativeRenderer, PreparedCreative } from "./creative-renderer";
import { SocialCreative } from "./social-creative";

const originalFetch = globalThis.fetch;
const originalClick = HTMLAnchorElement.prototype.click;
afterEach(() => {
  globalThis.fetch = originalFetch;
  HTMLAnchorElement.prototype.click = originalClick;
});
const serviceId = "0198f5a0-7b1c-7000-8000-000000000001";

function mockTreatment(readPrice: () => number) {
  globalThis.fetch = mock(async (url: unknown) =>
    Response.json(
      String(url).includes("/staff")
        ? { staff: [{ id: serviceId, displayName: "Stylist A", serviceIds: [serviceId] }] }
        : {
            services: [
              {
                id: serviceId,
                name: "Haircut",
                description: null,
                durationMinutes: 30,
                bufferMinutes: 0,
                priceCents: readPrice(),
                currency: "EUR",
              },
            ],
          },
    ),
  ) as unknown as typeof fetch;
}

test("a changed price after preview blocks export and keeps the operator's choices", async () => {
  let price = 2000;
  mockTreatment(() => price);
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
  fireEvent.change(await screen.findByLabelText("Choose a treatment"), {
    target: { value: serviceId },
  });
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
  expect(screen.getByLabelText("Choose a treatment")).toHaveValue(serviceId);
});

function RenamableCreative({ renderer }: { renderer: CreativeRenderer }) {
  const [name, setName] = useState("Original salon");
  return (
    <>
      <button type="button" onClick={() => setName("Renamed salon")}>
        Rename salon
      </button>
      <SocialCreative salonName={name} origin="https://booking.example" renderer={renderer} />
    </>
  );
}

test("a pending creative is discarded when the salon name changes", async () => {
  mockTreatment(() => 2000);
  const pending = Promise.withResolvers<PreparedCreative>();
  const renderer = mock(() => pending.promise);
  renderApp(<RenamableCreative renderer={renderer} />);
  fireEvent.change(await screen.findByLabelText("Choose a treatment"), {
    target: { value: serviceId },
  });
  fireEvent.click(screen.getByRole("button", { name: "Prepare preview" }));
  await waitFor(() => expect(renderer).toHaveBeenCalledTimes(1));

  fireEvent.click(screen.getByRole("button", { name: "Rename salon" }));
  await act(async () => {
    pending.resolve({
      dataUrl: "data:image/png;base64,cG9zdGVy",
      caption: "Haircut at Original salon",
      title: "Haircut",
      bookingUrl: "https://booking.example/book",
    });
  });
  expect(screen.queryByAltText("Creative preview: Haircut")).toBeNull();
  expect(screen.getByRole("button", { name: "Prepare preview" })).toBeEnabled();
});
