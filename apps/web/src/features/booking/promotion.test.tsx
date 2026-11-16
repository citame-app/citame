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
  globalThis.fetch = mock(async (_input, init) => {
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
  globalThis.fetch = mock(
    () =>
      new Promise<Response>((r) => {
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
    expect(screen.getByRole("button", { name: "Review offer" })).not.toBeDisabled(),
  );
  expect(screen.getByLabelText("Reviewed booking hash")).toHaveTextContent("none");
  expect(screen.getByLabelText("Booking can confirm")).toHaveTextContent("false");
});
