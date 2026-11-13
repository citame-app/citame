import { describe, expect, mock, test } from "bun:test";
import type { Appointment } from "@sob/contracts";
import { fireEvent, screen } from "@testing-library/react";
import { renderApp } from "../../../test/render";
import { AppointmentCard } from "./appointment-card";

const appointment: Appointment = {
  id: "0198f5a0-7b1c-7000-8000-000000000999",
  staffId: "0198f5a0-7b1c-7000-8000-000000000201",
  clientId: "0198f5a0-7b1c-7000-8000-000000000301",
  startsAt: "2026-03-09T12:00:00.000Z",
  endsAt: "2026-03-09T13:00:00.000Z",
  status: "booked",
  notes: null,
  version: 3,
  services: [
    {
      serviceId: "0198f5a0-7b1c-7000-8000-000000000101",
      name: "Haircut",
      durationMinutes: 45,
      bufferMinutes: 15,
      priceCents: 3000,
      currency: "USD",
    },
  ],
  createdAt: "2026-03-01T00:00:00.000Z",
  updatedAt: "2026-03-01T00:00:00.000Z",
};

const base = { appointment, staffName: "Stylist A", timeZone: "America/Argentina/Buenos_Aires" };

describe("AppointmentCard", () => {
  test("shows the date, time range, services, professional and total in the salon timezone", () => {
    renderApp(<AppointmentCard {...base} />);
    expect(screen.getByRole("heading", { name: /Monday, March 9/ })).toBeInTheDocument();
    expect(screen.getByText(/9:00.*10:00/)).toBeInTheDocument();
    expect(screen.getByText("Haircut")).toBeInTheDocument();
    expect(screen.getByText("Stylist A")).toBeInTheDocument();
    // One service price plus the total.
    expect(screen.getAllByText("$30")).toHaveLength(2);
    expect(screen.getByText("Upcoming")).toBeInTheDocument();
  });

  test("a cancelled appointment is labelled and offers no actions", () => {
    renderApp(
      <AppointmentCard
        {...base}
        appointment={{ ...appointment, status: "cancelled" }}
        onCancel={() => {}}
        onReschedule={() => {}}
      />,
    );
    expect(screen.getByText("Cancelled")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Cancel/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reschedule/ })).not.toBeInTheDocument();
  });

  test("upcoming appointments can be cancelled or rescheduled", () => {
    const onCancel = mock();
    const onReschedule = mock();
    renderApp(<AppointmentCard {...base} onCancel={onCancel} onReschedule={onReschedule} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Reschedule" }));
    expect(onCancel).toHaveBeenCalledWith(appointment);
    expect(onReschedule).toHaveBeenCalledWith(appointment);
  });

  test("a highlighted card is announced as the new booking", () => {
    renderApp(<AppointmentCard {...base} highlighted />);
    expect(screen.getByText("Just booked")).toBeInTheDocument();
  });

  test("a pending optimistic cancellation disables the actions", () => {
    renderApp(<AppointmentCard {...base} pending onCancel={() => {}} onReschedule={() => {}} />);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });
});
