import { afterEach, expect, mock, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { renderApp } from "../../../test/render";
import { BookingPeakPrice, useBookingPeakPrice } from "./peak-price";

const fetchBefore = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = fetchBefore;
});

const serviceId = "0198f5a0-7b1c-7000-8000-000000000101";

function Harness() {
  const [hour, setHour] = useState("09");
  const quote = useBookingPeakPrice([serviceId], `2026-11-23T${hour}:00:00Z`);
  return (
    <>
      <BookingPeakPrice quote={quote} currency="EUR" />
      <button type="button" onClick={() => setHour("10")}>
        Choose a different time
      </button>
      <button type="button" onClick={() => void quote.refetch()}>
        Review the latest price
      </button>
    </>
  );
}

test("the price review announces the current surcharge in Spanish and drops it for another slot", async () => {
  let peakSurcharge = 750;
  globalThis.fetch = mock(async (input) => {
    const url = new URL(String(input), "http://localhost");
    const startsAt = url.searchParams.get("startsAt");
    const surcharge = startsAt?.includes("T09:") ? peakSurcharge : 0;
    return Response.json({
      startsAt,
      review: surcharge ? "b".repeat(64) : null,
      services: [
        {
          serviceId,
          baseCents: 5000,
          currency: "EUR",
          surchargeCents: surcharge,
          priceCents: 5000 + surcharge,
        },
      ],
    });
  }) as unknown as typeof fetch;
  renderApp(<Harness />, { locale: "es-AR" });
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/Recargo.*7,50/));
  peakSurcharge = 1000;
  fireEvent.click(screen.getByRole("button", { name: "Review the latest price" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/Recargo.*10/));
  fireEvent.click(screen.getByRole("button", { name: "Choose a different time" }));
  await waitFor(() => expect(screen.getByRole("status")).toBeEmptyDOMElement());
});
