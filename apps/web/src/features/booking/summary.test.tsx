import { describe, expect, mock, test } from "bun:test";
import type { Service } from "@sob/contracts";
import { fireEvent, screen } from "@testing-library/react";
import { renderApp } from "../../../test/render";
import { bookingTotals } from "./logic";
import { BookingSummary } from "./summary";

const id = (n: number) => `0198f5a0-7b1c-7000-8000-${n.toString(16).padStart(12, "0")}`;
const svc = (n: number, name: string, durationMinutes: number, priceCents: number): Service => ({
  id: id(n),
  name,
  description: null,
  durationMinutes,
  bufferMinutes: 10,
  priceCents,
  currency: "USD",
});
const services = [svc(1, "Haircut", 45, 3000), svc(2, "Blow dry", 30, 2000)];

const base = {
  services,
  totals: bookingTotals(
    services,
    services.map((s) => s.id),
  ),
  timeZone: "America/Argentina/Buenos_Aires",
  ctaLabel: "Continue",
  onCta: () => {},
};

describe("BookingSummary", () => {
  test("lists the chosen services with a running total of duration and price", () => {
    renderApp(<BookingSummary {...base} />);
    expect(screen.getByRole("complementary", { name: "Your booking" })).toBeInTheDocument();
    expect(screen.getByText("Haircut")).toBeInTheDocument();
    expect(screen.getByText("Blow dry")).toBeInTheDocument();
    // The compact bar and the desktop panel each show the total; CSS displays one of them.
    expect(screen.getAllByText("$50").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/1h 15m/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/2 services/).length).toBeGreaterThanOrEqual(1);
  });

  test("shows an empty hint and disables the call to action without services", () => {
    renderApp(
      <BookingSummary {...base} services={[]} totals={bookingTotals([], [])} ctaDisabled />,
    );
    expect(screen.getByText("Pick at least one service to continue")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  test("the call to action reports clicks", () => {
    const onCta = mock();
    renderApp(<BookingSummary {...base} onCta={onCta} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onCta).toHaveBeenCalledTimes(1);
  });

  test("shows the professional and the chosen time in the salon timezone", () => {
    renderApp(
      <BookingSummary
        {...base}
        staffName="Stylist A"
        slot={{ startsAt: "2026-03-09T12:00:00.000Z" }}
      />,
    );
    expect(screen.getByText("Stylist A")).toBeInTheDocument();
    expect(screen.getByText(/Monday, March 9/)).toBeInTheDocument();
    expect(screen.getByText(/9:00/)).toBeInTheDocument();
  });

  test("the details toggle is an accessible disclosure for small screens", () => {
    renderApp(<BookingSummary {...base} />);
    const toggle = screen.getByRole("button", { name: /Details/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    const region = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
    expect(region).not.toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  test("services can be removed from the summary", () => {
    const onRemove = mock();
    renderApp(<BookingSummary {...base} onRemoveService={onRemove} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove Haircut" }));
    expect(onRemove).toHaveBeenCalledWith(id(1));
  });
});
