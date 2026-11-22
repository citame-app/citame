import { afterEach, expect, mock, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { renderApp } from "../../../test/render";
import { BookingPromotionReview, useBookingPromotion } from "./promotion";

const fetchBefore = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = fetchBefore;
});
const id = "0198f5a0-7b1c-7000-8000-000000000101";
const selection = {
  staffId: id,
  serviceIds: [id],
  serviceQuotes: { [id]: "a".repeat(64) },
  startsAt: "2026-11-17T09:00:00Z",
};
const quote = {
  name: "Quiet mornings",
  kind: "promotion",
  pointsUsed: 0,
  maximumPoints: 0,
  discountCents: 1000,
  currentTotalCents: 10000,
  newTotalCents: 9000,
  subtotalCents: 10000,
  currency: "EUR",
  promotionVersion: 1,
  reviewHash: "b".repeat(64),
  appointmentTiming: {
    timing: { weekdays: [2], startMinute: 600, endMinute: 780, lastMinuteHours: 24 },
    timeZone: "Europe/Madrid",
  },
};
function Harness({
  startsAt = selection.startsAt,
  subject = "client-a",
}: {
  startsAt?: string;
  subject?: string;
}) {
  const [changedStart, setChangedStart] = useState<string>();
  const state = useBookingPromotion({ ...selection, startsAt: changedStart ?? startsAt }, subject);
  return (
    <>
      <button type="button" onClick={() => setChangedStart("2026-11-17T10:00:00Z")}>
        Change booking time
      </button>
      <BookingPromotionReview state={state} />
      <output aria-label="Booking can confirm">{String(state.ready)}</output>
      <output aria-label="Reviewed booking hash">{state.payload?.reviewHash ?? "none"}</output>
    </>
  );
}
test("an optional code requires a current server quote and explicitly shows the net price and saved conditions", async () => {
  const packets: unknown[] = [];
  globalThis.fetch = mock(async (input, init) => {
    if (String(input).endsWith("/flash-offers")) return Response.json({ offers: [] });
    packets.push(JSON.parse(String(init?.body)));
    return Response.json(quote);
  }) as unknown as typeof fetch;
  renderApp(<Harness />);
  expect(screen.getByLabelText("Booking can confirm")).toHaveTextContent("true");
  fireEvent.change(screen.getByLabelText("Promotion code (optional)"), {
    target: { value: " quiet " },
  });
  expect(screen.getByLabelText("Booking can confirm")).toHaveTextContent("false");
  fireEvent.click(screen.getByRole("button", { name: "Review offer" }));
  expect(await screen.findByText("Save €10 · Booking total €90")).toBeInTheDocument();
  expect(screen.getByText(/Tuesday.*10:00.*13:00.*Europe\/Madrid/)).toBeInTheDocument();
  expect(packets[0]).toMatchObject({ ...selection, code: "QUIET" });
  expect(screen.getByLabelText("Reviewed booking hash")).toHaveTextContent("b".repeat(64));
  fireEvent.change(screen.getByLabelText("Promotion code (optional)"), {
    target: { value: "DIFFERENT" },
  });
  expect(screen.getByLabelText("Booking can confirm")).toHaveTextContent("false");
  expect(screen.queryByText("Save €10 · Booking total €90")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Remove code" }));
  expect(screen.getByLabelText("Booking can confirm")).toHaveTextContent("true");
});
test("a quote arriving after the appointment selection changed cannot approve the new booking", async () => {
  let resolve!: (r: Response) => void;
  globalThis.fetch = mock((input) =>
    String(input).endsWith("/flash-offers")
      ? Promise.resolve(Response.json({ offers: [] }))
      : new Promise<Response>((r) => {
          resolve = r;
        }),
  ) as unknown as typeof fetch;
  renderApp(<Harness />);
  fireEvent.change(screen.getByLabelText("Promotion code (optional)"), {
    target: { value: "QUIET" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review offer" }));
  await waitFor(() => expect(resolve).toBeDefined());
  fireEvent.click(screen.getByRole("button", { name: "Change booking time" }));
  resolve(Response.json(quote));
  await waitFor(() =>
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Review offer" }).disabled).toBe(
      false,
    ),
  );
  expect(screen.getByLabelText("Reviewed booking hash")).toHaveTextContent("none");
  expect(screen.getByLabelText("Booking can confirm")).toHaveTextContent("false");
});

test("selecting a public offer requests the booking quote immediately", async () => {
  const packets: unknown[] = [];
  globalThis.fetch = mock(async (input, init) => {
    if (String(input).endsWith("/flash-offers")) {
      return Response.json({
        offers: [
          {
            id,
            name: "Flash fixture",
            code: "FLASH10",
            kind: "percent",
            value: 1000,
            minimumSpendCents: 0,
            maximumDiscountCents: null,
            perClientLimit: 1,
            endsAt: "2026-11-17T19:00:00Z",
            allServices: false,
            services: [{ id, name: "Fixture service" }],
          },
        ],
      });
    }
    packets.push(JSON.parse(String(init?.body)));
    return Response.json(quote);
  }) as unknown as typeof fetch;
  renderApp(<Harness />);
  fireEvent.click(await screen.findByRole("button", { name: "Review offer Flash fixture" }));
  expect(await screen.findByText("Save €10 · Booking total €90")).toBeVisible();
  expect(screen.getByLabelText("Promotion code (optional)")).toHaveValue("FLASH10");
  expect(packets).toEqual([{ ...selection, code: "FLASH10" }]);
});
