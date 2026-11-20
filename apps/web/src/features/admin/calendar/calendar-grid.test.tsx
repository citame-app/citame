import { describe, expect, mock, test } from "bun:test";
import type { CalendarAppointment } from "@sob/contracts";
import { fireEvent, screen, within } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { CalendarGrid, type GridColumn } from "./calendar-grid";
import { appointmentEntries, indexCalendar, localMinuteRange } from "./presentation";

const TZ = "America/Argentina/Buenos_Aires";
const ANA = "0198f5a0-7b1c-7000-8000-000000000201";
const BEA = "0198f5a0-7b1c-7000-8000-000000000202";
const DATE = "2026-03-09";
const NOW = new Date("2026-03-09T15:20:00.000Z"); // 12:20 local

const columns: GridColumn[] = [
  { key: ANA, staffId: ANA, date: DATE, title: "Ana" },
  { key: BEA, staffId: BEA, date: DATE, title: "Bea" },
];

const appt = (
  id: string,
  staffId: string,
  hhmm: string,
  status: CalendarAppointment["status"] = "booked",
  client = "Lucia",
): CalendarAppointment => {
  const startsAt = `2026-03-09T${hhmm}:00.000Z`;
  return {
    id,
    staffId,
    clientId: "0198f5a0-7b1c-7000-8000-0000000000c1",
    startsAt,
    endsAt: new Date(Date.parse(startsAt) + 3_600_000).toISOString(),
    status,
    notes: null,
    version: 1,
    services: [],
    createdAt: startsAt,
    updatedAt: startsAt,
    clientName: client,
    serviceNames: ["Haircut"],
  };
};

const base = {
  columns,
  appointments: [
    appt("0198f5a0-7b1c-7000-8000-0000000000a1", ANA, "13:00"),
    appt("0198f5a0-7b1c-7000-8000-0000000000a2", BEA, "14:00", "no_show", "Paula"),
  ],
  timeOff: [
    {
      id: "0198f5a0-7b1c-7000-8000-0000000000b1",
      staffId: BEA,
      startsAt: "2026-03-09T16:00:00.000Z",
      endsAt: "2026-03-09T18:00:00.000Z",
      reason: "Dentist",
    },
  ],
  workingWindows: [
    { staffId: ANA, startsAt: "2026-03-09T12:00:00.000Z", endsAt: "2026-03-09T21:00:00.000Z" },
    { staffId: BEA, startsAt: "2026-03-09T12:00:00.000Z", endsAt: "2026-03-09T21:00:00.000Z" },
  ],
  timeZone: TZ,
  now: NOW,
  granularity: 15,
  showCancelled: false,
  canMove: () => true,
  onSlotClick: () => {},
  onOpenAppointment: () => {},
  onMove: () => {},
};

describe("CalendarGrid", () => {
  test("services have separate time blocks and open the same original reservation", () => {
    const visit = appt("multi", ANA, "13:00");
    visit.services = [
      {
        serviceId: null,
        name: "Manicure",
        durationMinutes: 45,
        bufferMinutes: 0,
        priceCents: 3000,
        currency: "EUR",
      },
      {
        serviceId: null,
        name: "Brows",
        durationMinutes: 15,
        bufferMinutes: 0,
        priceCents: 1500,
        currency: "EUR",
      },
    ];
    visit.serviceNames = ["Manicure", "Brows"];
    visit.serviceBadges = [
      {
        servicePosition: 0,
        requested: false,
        invoiced: true,
        paid: true,
        billingSource: "booksy",
        internalNote: false,
        customerComment: true,
      },
      {
        servicePosition: 1,
        requested: true,
        invoiced: false,
        paid: false,
        billingSource: null,
        internalNote: true,
        customerComment: false,
      },
    ];
    const entries = appointmentEntries(visit);
    expect(entries.map((entry) => entry.startsAt)).toEqual([
      "2026-03-09T13:00:00.000Z",
      "2026-03-09T13:45:00.000Z",
    ]);
    expect(entries[1]?.offsetMinutes).toBe(45);
    const onOpenAppointment = mock();
    renderApp(
      <CalendarGrid {...base} appointments={[visit]} onOpenAppointment={onOpenAppointment} />,
    );
    const manicure = screen.getByRole("button", { name: /10:00 AM.*Lucia.*Manicure.*Booked/ });
    const brows = screen.getByRole("button", { name: /10:45 AM.*Lucia.*Brows.*Booked/ });
    expect(within(manicure).getByRole("img", { name: "Paid in Booksy" })).toBeInTheDocument();
    expect(
      within(manicure).getByRole("img", { name: "Client comment from booking" }),
    ).toBeInTheDocument();
    expect(
      within(manicure).queryByRole("img", { name: "Client requested a specific professional" }),
    ).not.toBeInTheDocument();
    expect(
      within(brows).getByRole("img", { name: "Client requested a specific professional" }),
    ).toBeInTheDocument();
    expect(within(brows).getByRole("img", { name: "Internal notes" })).toBeInTheDocument();
    expect(within(brows).queryByRole("img", { name: "Paid in Booksy" })).not.toBeInTheDocument();
    fireEvent.click(brows);
    expect(onOpenAppointment).toHaveBeenCalledWith(visit);
  });

  test("overnight visits are indexed on both days and clipped at local midnight", () => {
    const visit = {
      ...appt("night", ANA, "13:00"),
      startsAt: "2026-03-10T02:45:00.000Z",
      endsAt: "2026-03-10T03:15:00.000Z",
    };
    const index = indexCalendar([visit], TZ);
    expect(index.byDay.get("2026-03-09")).toEqual([visit]);
    expect(index.byDay.get("2026-03-10")).toEqual([visit]);
    expect(localMinuteRange(visit, "2026-03-09", TZ)).toEqual({ start: 1425, end: 1440 });
    expect(localMinuteRange(visit, "2026-03-10", TZ)).toEqual({ start: 0, end: 15 });
    expect(localMinuteRange(visit, "2026-03-11", TZ)).toBeNull();
    expect(
      localMinuteRange(
        { startsAt: "2026-03-29T01:30:00Z", endsAt: "2026-03-29T02:30:00Z" },
        "2026-03-29",
        "Europe/Madrid",
      ),
    ).toEqual({ start: 210, end: 270 });
  });

  test("has one labelled column per team member", () => {
    renderApp(<CalendarGrid {...base} />);
    expect(screen.getByRole("group", { name: /Schedule for Ana/ })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /Schedule for Bea/ })).toBeInTheDocument();
  });

  test("an appointment is a button that names time, client, services and status", () => {
    renderApp(<CalendarGrid {...base} />);
    expect(
      screen.getByRole("button", { name: /10:00 AM.*Lucia.*Haircut.*Booked/ }),
    ).toBeInTheDocument();
    // the no-show carries its own label, not just a color
    expect(
      screen.getByRole("button", { name: /11:00 AM.*Paula.*Haircut.*No-show/ }),
    ).toBeInTheDocument();
  });

  test("shows working windows, time off and the current-time marker", () => {
    const { container } = renderApp(<CalendarGrid {...base} />);
    expect(container.querySelectorAll("[data-kind='working']")).toHaveLength(2);
    expect(screen.getByText("Time off: Dentist")).toBeInTheDocument();
    const marker = container.querySelectorAll("[data-kind='now']");
    expect(marker).toHaveLength(2);
    expect(screen.getAllByText("12:20 PM").length).toBeGreaterThan(0);
  });

  test("the now marker is absent on another day", () => {
    const { container } = renderApp(
      <CalendarGrid {...base} now={new Date("2026-03-12T15:00:00.000Z")} />,
    );
    expect(container.querySelectorAll("[data-kind='now']")).toHaveLength(0);
  });

  test("cancelled appointments are hidden unless asked for", () => {
    const cancelled = appt(
      "0198f5a0-7b1c-7000-8000-0000000000a3",
      ANA,
      "16:00",
      "cancelled",
      "Gone",
    );
    const { unmount } = renderApp(
      <CalendarGrid {...base} appointments={[...base.appointments, cancelled]} />,
    );
    expect(screen.queryByRole("button", { name: /Gone/ })).toBeNull();
    unmount();
    renderApp(
      <CalendarGrid {...base} appointments={[...base.appointments, cancelled]} showCancelled />,
    );
    expect(screen.getByRole("button", { name: /Gone.*Haircut.*Cancelled/ })).toBeInTheDocument();
  });

  test("clicking an empty spot reports the column and a snapped time", () => {
    const onSlotClick = mock();
    renderApp(<CalendarGrid {...base} onSlotClick={onSlotClick} />);
    const column = screen.getByRole("group", { name: /Schedule for Bea/ });
    const surface = within(column).getByTestId("slot-surface");
    // 8:00 grid start, 1.6 px per minute: 160px is 100 minutes later, 09:40, snapped to 09:45
    fireEvent.click(surface, { clientY: 160 });
    expect(onSlotClick).toHaveBeenCalledWith({
      staffId: BEA,
      date: DATE,
      minutesOfDay: 9 * 60 + 45,
    });
  });

  test("clicking an appointment opens it and does not create a new one", () => {
    const onSlotClick = mock();
    const onOpenAppointment = mock();
    renderApp(
      <CalendarGrid {...base} onSlotClick={onSlotClick} onOpenAppointment={onOpenAppointment} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Lucia/ }));
    expect(onOpenAppointment).toHaveBeenCalledTimes(1);
    expect(onSlotClick).not.toHaveBeenCalled();
  });

  test("Alt+arrow keys move a focused appointment, the keyboard alternative to dragging", () => {
    const onMove = mock();
    renderApp(<CalendarGrid {...base} onMove={onMove} />);
    const block = screen.getByRole("button", { name: /Lucia/ });
    fireEvent.keyDown(block, { key: "ArrowDown", altKey: true });
    expect(onMove).toHaveBeenCalledWith(
      expect.objectContaining({ id: "0198f5a0-7b1c-7000-8000-0000000000a1" }),
      {
        staffId: ANA,
        startsAt: "2026-03-09T13:15:00.000Z",
      },
    );
    fireEvent.keyDown(block, { key: "ArrowRight", altKey: true });
    expect(onMove).toHaveBeenLastCalledWith(expect.anything(), {
      staffId: BEA,
      startsAt: "2026-03-09T13:00:00.000Z",
    });
  });

  test("appointments that cannot be moved ignore the keyboard move", () => {
    const onMove = mock();
    renderApp(<CalendarGrid {...base} canMove={() => false} onMove={onMove} />);
    fireEvent.keyDown(screen.getByRole("button", { name: /Lucia/ }), {
      key: "ArrowDown",
      altKey: true,
    });
    expect(onMove).not.toHaveBeenCalled();
  });

  test("overlapping appointments share the column width", () => {
    const a = appt("0198f5a0-7b1c-7000-8000-0000000000a4", ANA, "13:00", "booked", "One");
    const b = appt("0198f5a0-7b1c-7000-8000-0000000000a5", ANA, "13:30", "booked", "Two");
    renderApp(<CalendarGrid {...base} appointments={[a, b]} />);
    const one = screen.getByRole("button", { name: /One/ }).closest("[data-block]") as HTMLElement;
    const two = screen.getByRole("button", { name: /Two/ }).closest("[data-block]") as HTMLElement;
    expect(one.style.width).toBe("50%");
    expect(two.style.left).toBe("50%");
  });
});

test("a processing card announces its visible timing before the visible booking status", () => {
  const visit = appt("0198f5a0-7b1c-7000-8000-0000000000a6", ANA, "13:00");
  visit.workWindows = [
    { offsetMinutes: 0, endOffsetMinutes: 15 },
    { offsetMinutes: 45, endOffsetMinutes: 60 },
  ];
  renderApp(<CalendarGrid {...base} appointments={[visit]} />);
  expect(screen.getByRole("button", { name: /Lucia.*Haircut.*Processing:.*Booked/ })).toBeVisible();
  expect(screen.getByRole("button", { name: /Lucia/ })).toHaveTextContent(/AM Booked/);
});
